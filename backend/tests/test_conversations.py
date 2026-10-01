import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

from bson import ObjectId
import pytest
from fastapi import HTTPException

from app.routes.conversations import (
    ConversationCreateRequest,
    create_conversation,
    get_member_conversation,
)
from app.routes.auth import UserReply
from app.routes.messages import MessageCreateRequest, create_message, list_messages


class FakeCollection:
    def __init__(self) -> None:
        self.inserted: list[dict] = []

    async def insert_one(self, document: dict) -> SimpleNamespace:
        document["_id"] = ObjectId()
        self.inserted.append(document)
        return SimpleNamespace(inserted_id=document["_id"])


class FakeDatabase:
    def __init__(self) -> None:
        self.conversations = FakeCollection()
        self.conversation_memberships = FakeCollection()


def test_create_conversation_returns_id_and_expected_fields() -> None:
    database = FakeDatabase()
    user = UserReply(
        id=str(ObjectId()),
        email="user@example.com",
        username=f"user_{uuid4().hex[:8]}",
        created_at=datetime.now(timezone.utc),
        email_verified=True,
    )

    response = asyncio.run(
        create_conversation(
            ConversationCreateRequest(kind="group"),
            user=user,
            database=database,
        )
    )

    assert response.id == str(database.conversations.inserted[0]["_id"])
    assert response.kind == "group"
    assert response.owner_id == user.id
    assert response.created_at == response.updated_at


def test_get_member_conversation_rejects_non_member() -> None:
    class Memberships:
        async def find_one(self, _: dict) -> None:
            return None

    class Database:
        conversation_memberships = Memberships()

    user = UserReply(
        id=str(ObjectId()),
        email="user@example.com",
        username=f"user_{uuid4().hex[:8]}",
        created_at=datetime.now(timezone.utc),
        email_verified=True,
    )

    with pytest.raises(HTTPException) as error:
        asyncio.run(get_member_conversation(str(ObjectId()), user, Database()))

    assert error.value.status_code == 404


def test_create_message_persists_and_broadcasts_to_members(monkeypatch: pytest.MonkeyPatch) -> None:
    conversation_id = ObjectId()
    sender_id = ObjectId()
    recipient_id = ObjectId()

    class Memberships:
        async def find_one(self, _: dict) -> dict:
            return {"conversation_id": conversation_id}

        def find(self, _: dict, __: dict) -> SimpleNamespace:
            return SimpleNamespace(
                to_list=lambda length: asyncio.sleep(
                    0,
                    result=[{"user_id": sender_id}, {"user_id": recipient_id}],
                )
            )

    class Messages:
        async def insert_one(self, document: dict) -> None:
            document["_id"] = ObjectId()

    class Conversations:
        async def find_one(self, _: dict) -> dict:
            return {
                "_id": conversation_id,
                "owner_id": sender_id,
                "kind": "group",
                "created_at": datetime.now(timezone.utc),
                "updated_at": datetime.now(timezone.utc),
            }

        async def update_one(self, *_: object) -> None:
            return None

    class Database:
        conversation_memberships = Memberships()
        messages = Messages()
        conversations = Conversations()

    user = UserReply(
        id=str(sender_id),
        email="user@example.com",
        username="sender",
        created_at=datetime.now(timezone.utc),
        email_verified=True,
    )
    broadcasts: list[tuple[list[ObjectId], dict]] = []

    async def fake_publish(user_ids: list[ObjectId], event: dict) -> None:
        broadcasts.append((user_ids, event))

    monkeypatch.setattr("app.routes.messages.publish", fake_publish)

    response = asyncio.run(
        create_message(
            MessageCreateRequest(content="hello"),
            conversation_id=str(conversation_id),
            user=user,
            database=Database(),
        )
    )

    assert response.content == "hello"
    assert broadcasts[0][0] == [sender_id, recipient_id]
    assert broadcasts[0][1]["type"] == "message"
    assert broadcasts[0][1]["message"]["id"] == response.id


def test_list_messages_returns_ascending_page_before_cursor() -> None:
    conversation_id = ObjectId()
    sender_id = ObjectId()
    newest = datetime(2025, 1, 2, tzinfo=timezone.utc)
    oldest = datetime(2025, 1, 1, tzinfo=timezone.utc)

    class Memberships:
        async def find_one(self, _: dict) -> dict:
            return {"conversation_id": conversation_id}

    class Cursor:
        def sort(self, *_: object) -> "Cursor":
            return self

        def limit(self, _: int) -> "Cursor":
            return self

        async def to_list(self, _: int) -> list[dict]:
            return [
                {
                    "_id": ObjectId(),
                    "conversation_id": conversation_id,
                    "sender_id": sender_id,
                    "content": "newer",
                    "client_id": "newer-client",
                    "created_at": newest,
                },
                {
                    "_id": ObjectId(),
                    "conversation_id": conversation_id,
                    "sender_id": sender_id,
                    "content": "older",
                    "client_id": "older-client",
                    "created_at": oldest,
                },
            ]

    class Messages:
        def find(self, _: dict) -> Cursor:
            return Cursor()

    class Conversations:
        async def find_one(self, _: dict) -> dict:
            return {"_id": conversation_id}

    class Database:
        conversation_memberships = Memberships()
        messages = Messages()
        conversations = Conversations()

    user = UserReply(
        id=str(sender_id),
        email="user@example.com",
        username="sender",
        created_at=datetime.now(timezone.utc),
        email_verified=True,
    )

    response = asyncio.run(
        list_messages(
            conversation_id=str(conversation_id),
            before=newest,
            limit=2,
            user=user,
            database=Database(),
        )
    )

    assert [message.content for message in response] == ["older", "newer"]


def test_create_message_rejects_empty_or_oversized_content() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        MessageCreateRequest(content="")

    with pytest.raises(ValidationError):
        MessageCreateRequest(content="a" * 4001)

    valid = MessageCreateRequest(content="a" * 4000)
    assert len(valid.content) == 4000


def test_invalid_conversation_id_raises_404() -> None:
    from app.routes.conversations import conversation_id

    with pytest.raises(HTTPException) as exc:
        conversation_id("invalid-id-format")
    assert exc.value.status_code == 404


def test_sender_id_derived_from_authenticated_user_only() -> None:
    # Verify schema has no client-specified sender field
    payload = MessageCreateRequest(content="test message")
    assert not hasattr(payload, "sender_id")
    assert not hasattr(payload, "sender")


def test_delete_conversation_owner_or_direct_deletes_all() -> None:
    from app.routes.conversations import delete_conversation

    conv_oid = ObjectId()
    user_oid = ObjectId()

    deleted = {"conversations": False, "memberships": False, "messages": False}

    class MockConversations:
        async def find_one(self, query: dict) -> dict:
            return {"_id": conv_oid, "owner_id": user_oid, "kind": "group"}

        async def delete_one(self, query: dict) -> None:
            deleted["conversations"] = True

    class MockMemberships:
        async def find_one(self, query: dict) -> dict:
            return {"conversation_id": conv_oid, "user_id": user_oid}

        async def delete_many(self, query: dict) -> None:
            deleted["memberships"] = True

    class MockMessages:
        async def delete_many(self, query: dict) -> None:
            deleted["messages"] = True

    class MockDatabase:
        conversations = MockConversations()
        conversation_memberships = MockMemberships()
        messages = MockMessages()

    user = UserReply(
        id=str(user_oid),
        email="owner@example.com",
        username="owner",
        created_at=datetime.now(timezone.utc),
        email_verified=True,
    )

    asyncio.run(
        delete_conversation(
            raw_id=str(conv_oid),
            user=user,
            database=MockDatabase(),
        )
    )

    assert deleted["conversations"] is True
    assert deleted["memberships"] is True
    assert deleted["messages"] is True


