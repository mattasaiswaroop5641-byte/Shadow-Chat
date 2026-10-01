import asyncio
from datetime import datetime, timezone
import io
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from bson import ObjectId
from fastapi import HTTPException, UploadFile

from app.core.config import get_uploads_dir
from app.routes.auth import UserReply
from app.routes.messages import (
    Attachment,
    MessageCreateRequest,
    MessageReactionRequest,
    MessageUpdateRequest,
    create_message,
    delete_message,
    edit_message,
    toggle_reaction,
    upload_attachment,
)


def make_user(username: str, user_id: ObjectId | None = None) -> UserReply:
    uid = user_id or ObjectId()
    return UserReply(
        id=str(uid),
        email=f"{username}@example.com",
        username=username,
        created_at=datetime.now(timezone.utc),
        email_verified=True,
    )


class AsyncCursor:
    def __init__(self, items: list[dict[str, Any]]) -> None:
        self.items = items

    def limit(self, count: object) -> "AsyncCursor":
        val = count.default if hasattr(count, "default") else count
        return AsyncCursor(self.items[: int(val)])

    def sort(self, key: str, direction: int = 1) -> "AsyncCursor":
        reverse = direction < 0
        sorted_items = sorted(self.items, key=lambda x: x.get(key, 0), reverse=reverse)
        return AsyncCursor(sorted_items)

    async def to_list(self, length: int) -> list[dict[str, Any]]:
        return self.items[:length]


class MockCollection:
    def __init__(self, name: str) -> None:
        self.name = name
        self.documents: list[dict[str, Any]] = []

    async def insert_one(self, document: dict[str, Any]) -> SimpleNamespace:
        if "_id" not in document:
            document["_id"] = ObjectId()
        self.documents.append(document)
        return SimpleNamespace(inserted_id=document["_id"])

    async def find_one(
        self, query: dict[str, Any], projection: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        for doc in self.documents:
            match = True
            for k, v in query.items():
                if k == "$or":
                    or_match = False
                    for cond in v:
                        if all(doc.get(ck) == cv for ck, cv in cond.items()):
                            or_match = True
                            break
                    if not or_match:
                        match = False
                        break
                elif doc.get(k) != v:
                    match = False
                    break
            if match:
                return dict(doc)
        return None

    def find(
        self, query: dict[str, Any], projection: dict[str, Any] | None = None
    ) -> AsyncCursor:
        matched = []
        for doc in self.documents:
            match = True
            for k, v in query.items():
                if k == "$in":
                    continue
                if isinstance(v, dict):
                    if "$lt" in v and doc.get(k) >= v["$lt"]:
                        match = False
                    if "$ne" in v and doc.get(k) == v["$ne"]:
                        match = False
                elif doc.get(k) != v:
                    match = False
                    break
            if match:
                matched.append(dict(doc))
        return AsyncCursor(matched)

    async def update_one(
        self, query: dict[str, Any], update: dict[str, Any]
    ) -> SimpleNamespace:
        for doc in self.documents:
            if all(doc.get(k) == v for k, v in query.items() if not k.startswith("$")):
                if "$set" in update:
                    for sk, sv in update["$set"].items():
                        doc[sk] = sv
                return SimpleNamespace(modified_count=1)
        return SimpleNamespace(modified_count=0)

    async def update_many(
        self, query: dict[str, Any], update: dict[str, Any]
    ) -> SimpleNamespace:
        count = 0
        for doc in self.documents:
            if all(doc.get(k) == v for k, v in query.items() if not k.startswith("$")):
                if "$set" in update:
                    for sk, sv in update["$set"].items():
                        doc[sk] = sv
                count += 1
        return SimpleNamespace(modified_count=count)


class MockDatabase:
    def __init__(self) -> None:
        self.conversations = MockCollection("conversations")
        self.conversation_memberships = MockCollection("conversation_memberships")
        self.messages = MockCollection("messages")
        self.users = MockCollection("users")


def setup_test_conversation(database: MockDatabase, owner: UserReply, member: UserReply | None = None):
    conv_id = ObjectId()
    conv = {
        "_id": conv_id,
        "kind": "group",
        "owner_id": ObjectId(owner.id),
        "title": "General",
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    }
    database.conversations.documents.append(conv)
    database.conversation_memberships.documents.append({
        "_id": ObjectId(),
        "conversation_id": conv_id,
        "user_id": ObjectId(owner.id),
        "role": "owner",
        "created_at": datetime.now(timezone.utc),
    })
    if member:
        database.conversation_memberships.documents.append({
            "_id": ObjectId(),
            "conversation_id": conv_id,
            "user_id": ObjectId(member.id),
            "role": "member",
            "created_at": datetime.now(timezone.utc),
        })
    return str(conv_id)


def test_attachment_upload_and_retrieval() -> None:
    database = MockDatabase()
    alice = make_user("alice")
    conv_id = setup_test_conversation(database, alice)

    file_bytes = b"Hello, this is a secret test attachment document."
    fake_file = UploadFile(
        file=io.BytesIO(file_bytes),
        filename="secret.txt",
        headers={"content-type": "text/plain"},
    )

    attachment = asyncio.run(
        upload_attachment(
            conversation_id=conv_id,
            file=fake_file,
            user=alice,
            database=database,
        )
    )

    assert attachment.filename == "secret.txt"
    assert attachment.size_bytes == len(file_bytes)
    assert attachment.url.startswith("/attachments/")

    # Check file exists on disk in get_uploads_dir()
    saved_filename = attachment.url.replace("/attachments/", "")
    saved_path = get_uploads_dir() / saved_filename
    assert saved_path.is_file()
    assert saved_path.read_bytes() == file_bytes


def test_attachment_upload_size_limit() -> None:
    database = MockDatabase()
    alice = make_user("alice")
    conv_id = setup_test_conversation(database, alice)

    # 16 MB exceeds 15 MB limit
    huge_bytes = b"0" * (16 * 1024 * 1024)
    fake_file = UploadFile(
        file=io.BytesIO(huge_bytes),
        filename="huge.bin",
        headers={"content-type": "application/octet-stream"},
    )

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            upload_attachment(
                conversation_id=conv_id,
                file=fake_file,
                user=alice,
                database=database,
            )
        )
    assert exc_info.value.status_code == 413


def test_message_reply_and_attachments() -> None:
    database = MockDatabase()
    alice = make_user("alice")
    bob = make_user("bob")
    database.users.documents.append({"_id": ObjectId(alice.id), "username": alice.username})
    database.users.documents.append({"_id": ObjectId(bob.id), "username": bob.username})
    conv_id = setup_test_conversation(database, alice, bob)

    # Alice sends initial message
    msg1 = asyncio.run(
        create_message(
            payload=MessageCreateRequest(content="Original prompt"),
            conversation_id=conv_id,
            user=alice,
            database=database,
        )
    )

    # Bob sends reply with an attachment
    att = Attachment(
        id=uuid4().hex[:12],
        filename="diagram.png",
        content_type="image/png",
        size_bytes=4096,
        url="/attachments/test.png",
    )
    reply_msg = asyncio.run(
        create_message(
            payload=MessageCreateRequest(
                content="Quoted answer",
                reply_to_id=msg1.id,
                attachments=[att],
            ),
            conversation_id=conv_id,
            user=bob,
            database=database,
        )
    )

    assert reply_msg.reply_to_id == msg1.id
    assert reply_msg.reply_to is not None
    assert reply_msg.reply_to.id == msg1.id
    assert reply_msg.reply_to.sender_username == "alice"
    assert reply_msg.reply_to.content == "Original prompt"
    assert len(reply_msg.attachments) == 1
    assert reply_msg.attachments[0].filename == "diagram.png"


def test_toggle_reaction() -> None:
    database = MockDatabase()
    alice = make_user("alice")
    bob = make_user("bob")
    conv_id = setup_test_conversation(database, alice, bob)

    msg = asyncio.run(
        create_message(
            payload=MessageCreateRequest(content="React to me"),
            conversation_id=conv_id,
            user=alice,
            database=database,
        )
    )

    # Bob reacts with heart
    rx1 = asyncio.run(
        toggle_reaction(
            payload=MessageReactionRequest(emoji="❤️"),
            conversation_id=conv_id,
            message_id=msg.id,
            user=bob,
            database=database,
        )
    )
    assert "❤️" in rx1
    assert bob.id in rx1["❤️"]

    # Bob reacts again with heart -> toggled off
    rx2 = asyncio.run(
        toggle_reaction(
            payload=MessageReactionRequest(emoji="❤️"),
            conversation_id=conv_id,
            message_id=msg.id,
            user=bob,
            database=database,
        )
    )
    assert "❤️" not in rx2


def test_message_edit() -> None:
    database = MockDatabase()
    alice = make_user("alice")
    bob = make_user("bob")
    conv_id = setup_test_conversation(database, alice, bob)

    msg = asyncio.run(
        create_message(
            payload=MessageCreateRequest(content="Original content"),
            conversation_id=conv_id,
            user=alice,
            database=database,
        )
    )

    # Bob tries to edit Alice's message -> 403 Forbidden
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            edit_message(
                payload=MessageUpdateRequest(content="Malicious edit"),
                conversation_id=conv_id,
                message_id=msg.id,
                user=bob,
                database=database,
            )
        )
    assert exc_info.value.status_code == 403

    # Alice edits her message
    edited = asyncio.run(
        edit_message(
            payload=MessageUpdateRequest(content="Polished content"),
            conversation_id=conv_id,
            message_id=msg.id,
            user=alice,
            database=database,
        )
    )
    assert edited.content == "Polished content"
    assert edited.is_edited is True
    assert edited.edited_at is not None


def test_tombstone_message_deletion() -> None:
    database = MockDatabase()
    alice = make_user("alice")
    bob = make_user("bob")
    conv_id = setup_test_conversation(database, alice, bob)

    msg = asyncio.run(
        create_message(
            payload=MessageCreateRequest(content="Confidential leak"),
            conversation_id=conv_id,
            user=alice,
            database=database,
        )
    )

    # Bob cannot delete Alice's message (not sender, not owner)
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            delete_message(
                conversation_id=conv_id,
                message_id=msg.id,
                user=bob,
                database=database,
            )
        )
    assert exc_info.value.status_code == 403

    # Alice deletes her message
    res = asyncio.run(
        delete_message(
            conversation_id=conv_id,
            message_id=msg.id,
            user=alice,
            database=database,
        )
    )
    assert res["status"] == "ok"

    # Check tombstone in database
    tombstone = next(d for d in database.messages.documents if d["_id"] == ObjectId(msg.id))
    assert tombstone["is_deleted"] is True
    assert tombstone["content"] == "[This message was deleted]"
    assert tombstone["attachments"] == []
    assert tombstone["reactions"] == {}

    # Cannot edit deleted message
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            edit_message(
                payload=MessageUpdateRequest(content="Reviving"),
                conversation_id=conv_id,
                message_id=msg.id,
                user=alice,
                database=database,
            )
        )
    assert exc_info.value.status_code == 400
