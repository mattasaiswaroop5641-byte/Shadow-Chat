import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any

from bson import ObjectId
import pytest
from fastapi import HTTPException

from app.routes.auth import UserReply
from app.routes.conversations import (
    ConversationCreateRequest,
    create_conversation,
    list_members,
)
from app.routes.messages import (
    MessageCreateRequest,
    create_message,
    list_messages,
)
from app.routes.users import (
    PublicKeyUpdateRequest,
    get_user_public_key,
    update_public_key,
)


class MockCollection:
    def __init__(self, initial_items: list[dict[str, Any]] | None = None) -> None:
        self.items: list[dict[str, Any]] = initial_items or []
        self.inserted: list[dict[str, Any]] = []

    async def insert_one(self, doc: dict[str, Any]) -> SimpleNamespace:
        if "_id" not in doc:
            doc["_id"] = ObjectId()
        self.inserted.append(doc)
        self.items.append(doc)
        return SimpleNamespace(inserted_id=doc["_id"])

    async def find_one(self, query: dict[str, Any], projection: dict[str, Any] | None = None) -> dict[str, Any] | None:
        for item in self.items:
            match = True
            for k, v in query.items():
                if item.get(k) != v:
                    match = False
                    break
            if match:
                return item
        return None

    def find(self, query: dict[str, Any], projection: dict[str, Any] | None = None) -> "AsyncCursor":
        matching = []
        for item in self.items:
            match = True
            for k, v in query.items():
                if k == "$or" and isinstance(v, list):
                    or_match = any(item.get(ck) == cv for cond in v for ck, cv in cond.items())
                    if not or_match:
                        match = False
                        break
                elif k == "_id" and isinstance(v, dict) and "$in" in v:
                    if item.get("_id") not in v["$in"]:
                        match = False
                        break
                elif item.get(k) != v:
                    match = False
                    break
            if match:
                matching.append(item)
        return AsyncCursor(matching)

    async def update_one(self, query: dict[str, Any], update: dict[str, Any]) -> SimpleNamespace:
        for item in self.items:
            match = all(item.get(k) == v for k, v in query.items())
            if match:
                if "$set" in update:
                    item.update(update["$set"])
                return SimpleNamespace(modified_count=1)
        return SimpleNamespace(modified_count=0)


class AsyncCursor:
    def __init__(self, items: list[dict[str, Any]]) -> None:
        self.items = items

    def limit(self, count: int) -> "AsyncCursor":
        return AsyncCursor(self.items[:count])

    def sort(self, key: str, direction: int = 1) -> "AsyncCursor":
        reverse = direction < 0
        sorted_items = sorted(
            self.items,
            key=lambda x: (x.get(key, 0), str(x.get("_id", ""))),
            reverse=reverse,
        )
        return AsyncCursor(sorted_items)

    async def to_list(self, length: int) -> list[dict[str, Any]]:
        return self.items[:length]


class MockDatabase:
    def __init__(self) -> None:
        self.users = MockCollection()
        self.conversations = MockCollection()
        self.conversation_memberships = MockCollection()
        self.messages = MockCollection()


def make_user(username: str) -> UserReply:
    return UserReply(
        id=str(ObjectId()),
        email=f"{username}@example.com",
        username=username,
        created_at=datetime.now(timezone.utc),
        email_verified=True,
    )


# 1. Test Public Key Upload and Retrieval
def test_public_key_upload_and_retrieval() -> None:
    db = MockDatabase()
    alice = make_user("alice")
    db.users.items.append({"_id": ObjectId(alice.id), "username": "alice"})

    dummy_spki_base64 = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1234567890abcdefABCDEF1234567890abcdefABCDEF1234567890abcdefABCDEF1234567890"

    # Alice uploads her ECDH public key
    asyncio.run(
        update_public_key(
            PublicKeyUpdateRequest(public_key=dummy_spki_base64),
            user=alice,
            database=db,
        )
    )

    # Bob retrieves Alice's public key
    bob = make_user("bob")
    res = asyncio.run(get_user_public_key(user_id=alice.id, user=bob, database=db))
    assert res.user_id == alice.id
    assert res.public_key == dummy_spki_base64


# 2. Test Encrypted Message Creation, Storage, and Broadcast
def test_encrypted_message_persistence_and_broadcast(monkeypatch: pytest.MonkeyPatch) -> None:
    db = MockDatabase()
    alice = make_user("alice")
    bob = make_user("bob")
    dummy_key_bob = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbobPublicDummyKey1234567890abcdefABCDEF1234567890abcdefABCDEF"
    db.users.items.extend([
        {"_id": ObjectId(alice.id), "username": "alice"},
        {"_id": ObjectId(bob.id), "username": "bob", "public_key": dummy_key_bob},
    ])

    # Alice creates DM with Bob
    conv = asyncio.run(
        create_conversation(
            ConversationCreateRequest(kind="direct", recipient_id=bob.id),
            user=alice,
            database=db,
        )
    )

    published_events: list[dict[str, Any]] = []

    async def mock_publish(user_ids: list[ObjectId], event: dict[str, Any]) -> None:
        published_events.append(event)

    monkeypatch.setattr("app.routes.messages.publish", mock_publish)

    ciphertext_payload = "4vG+dK6/ciphertextPayloadDummyString=="
    nonce_payload = "vM8492049102"

    # Alice sends zero-knowledge E2EE message
    msg = asyncio.run(
        create_message(
            MessageCreateRequest(
                content=ciphertext_payload,
                nonce=nonce_payload,
                is_encrypted=True,
            ),
            conversation_id=conv.id,
            user=alice,
            database=db,
        )
    )

    # Check MessageReply fields
    assert msg.content == ciphertext_payload
    assert msg.nonce == nonce_payload
    assert msg.is_encrypted is True

    # Check database document has NO plaintext
    db_doc = db.messages.items[0]
    assert db_doc["content"] == ciphertext_payload
    assert db_doc["nonce"] == nonce_payload
    assert db_doc["is_encrypted"] is True

    # Check real-time WebSocket broadcast carries nonce and is_encrypted
    assert len(published_events) == 1
    assert published_events[0]["message"]["content"] == ciphertext_payload
    assert published_events[0]["message"]["nonce"] == nonce_payload
    assert published_events[0]["message"]["is_encrypted"] is True

    # Check list_messages returns nonce and is_encrypted
    messages = asyncio.run(list_messages(conversation_id=conv.id, user=bob, database=db))
    assert len(messages) == 1
    assert messages[0].content == ciphertext_payload
    assert messages[0].nonce == nonce_payload
    assert messages[0].is_encrypted is True

    # Check list_members includes public_key
    members = asyncio.run(list_members(raw_id=conv.id, user=alice, database=db))
    bob_member = next(m for m in members if m.user_id == bob.id)
    assert bob_member.public_key == dummy_key_bob
