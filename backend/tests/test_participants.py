import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

from bson import ObjectId
import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.routes.auth import UserReply
from app.routes.conversations import (
    AddMemberRequest,
    ConversationCreateRequest,
    add_member,
    create_conversation,
    list_members,
)
from app.routes.messages import MessageCreateRequest, create_message, list_messages
from app.routes.users import search_users


def make_request(path: str = "/users/search", client_ip: str = "127.0.0.1") -> Request:
    scope = {
        "type": "http",
        "method": "GET",
        "path": path,
        "headers": [],
        "client": (client_ip, 12345),
    }
    return Request(scope)


def make_user(username: str = "testuser", user_id: ObjectId | None = None) -> UserReply:
    uid = user_id or ObjectId()
    return UserReply(
        id=str(uid),
        email=f"{username}@example.com",
        username=username,
        created_at=datetime.now(timezone.utc),
        email_verified=True,
    )


class AsyncCursor:
    def __init__(self, items: list[dict]) -> None:
        self.items = items

    def limit(self, count: object) -> "AsyncCursor":
        limit_val = count.default if hasattr(count, "default") else count
        return AsyncCursor(self.items[: int(limit_val)])

    def sort(self, *_: object, **__: object) -> "AsyncCursor":
        return self

    async def to_list(self, length: object) -> list[dict]:
        length_val = length.default if hasattr(length, "default") else length
        return self.items[: int(length_val)]


class MockCollection:
    def __init__(self, initial_items: list[dict] | None = None) -> None:
        self.items: list[dict] = initial_items or []
        self.inserted: list[dict] = []

    async def insert_one(self, doc: dict) -> SimpleNamespace:
        if "_id" not in doc:
            doc["_id"] = ObjectId()
        self.inserted.append(doc)
        self.items.append(doc)
        return SimpleNamespace(inserted_id=doc["_id"])

    async def find_one(self, query: dict) -> dict | None:
        for item in self.items:
            match = True
            for k, v in query.items():
                if k == "$or" and isinstance(v, list):
                    or_match = False
                    for cond in v:
                        cond_k, cond_v = next(iter(cond.items()))
                        if item.get(cond_k) == cond_v:
                            or_match = True
                            break
                    if not or_match:
                        match = False
                        break
                elif k == "conversation_id" and isinstance(v, dict) and "$in" in v:
                    if item.get(k) not in v["$in"]:
                        match = False
                        break
                elif k == "_id" and isinstance(v, dict) and "$in" in v:
                    if item.get(k) not in v["$in"]:
                        match = False
                        break
                elif item.get(k) != v:
                    match = False
                    break
            if match:
                return item
        return None

    def find(self, query: dict, projection: dict | None = None) -> AsyncCursor:
        matched = []
        for item in self.items:
            match = True
            for k, v in query.items():
                if k == "_id" and isinstance(v, dict) and "$ne" in v:
                    if item.get("_id") == v["$ne"]:
                        match = False
                        break
                elif k == "_id" and isinstance(v, dict) and "$in" in v:
                    if item.get("_id") not in v["$in"]:
                        match = False
                        break
                elif k == "username_lower" and isinstance(v, dict) and "$regex" in v:
                    regex = v["$regex"].lstrip("^")
                    if not item.get("username_lower", "").startswith(regex):
                        match = False
                        break
                elif k == "conversation_id" and isinstance(v, dict) and "$in" in v:
                    if item.get("conversation_id") not in v["$in"]:
                        match = False
                        break
                elif item.get(k) != v:
                    match = False
                    break
            if match:
                matched.append(item)
        return AsyncCursor(matched)

    async def delete_one(self, query: dict) -> None:
        to_remove = await self.find_one(query)
        if to_remove and to_remove in self.items:
            self.items.remove(to_remove)

    async def delete_many(self, query: dict) -> None:
        pass

    async def update_one(self, query: dict, update: dict) -> None:
        pass


class MockDatabase:
    def __init__(self) -> None:
        self.users = MockCollection()
        self.conversations = MockCollection()
        self.conversation_memberships = MockCollection()
        self.messages = MockCollection()


# 1. User Search
def test_search_users_returns_safe_fields_and_filters_query() -> None:
    db = MockDatabase()
    user_alice = make_user("alice")
    user_bob = make_user("bob")
    user_bobby = make_user("bobby")
    user_charlie = make_user("charlie")

    db.users.items.extend([
        {"_id": ObjectId(user_alice.id), "username": "alice", "username_lower": "alice", "password_hash": "secret", "email": "alice@ex.com"},
        {"_id": ObjectId(user_bob.id), "username": "bob", "username_lower": "bob", "password_hash": "secret", "email": "bob@ex.com"},
        {"_id": ObjectId(user_bobby.id), "username": "bobby", "username_lower": "bobby", "password_hash": "secret", "email": "bobby@ex.com"},
        {"_id": ObjectId(user_charlie.id), "username": "charlie", "username_lower": "charlie", "password_hash": "secret", "email": "charlie@ex.com"},
    ])

    req = make_request()
    results = asyncio.run(search_users(req, q="bo", user=user_alice, database=db))

    assert len(results) == 2
    usernames = {u.username for u in results}
    assert usernames == {"bob", "bobby"}
    for u in results:
        assert not hasattr(u, "password_hash")
        assert not hasattr(u, "email")


def test_search_users_excludes_caller() -> None:
    db = MockDatabase()
    user_bob = make_user("bob")
    user_bobby = make_user("bobby")

    db.users.items.extend([
        {"_id": ObjectId(user_bob.id), "username": "bob", "username_lower": "bob"},
        {"_id": ObjectId(user_bobby.id), "username": "bobby", "username_lower": "bobby"},
    ])

    req = make_request()
    results = asyncio.run(search_users(req, q="bo", user=user_bob, database=db))

    assert len(results) == 1
    assert results[0].username == "bobby"


# 2. Direct Conversations
def test_create_direct_conversation_with_valid_recipient() -> None:
    db = MockDatabase()
    sender = make_user("sender")
    recipient = make_user("recipient")
    db.users.items.append({"_id": ObjectId(recipient.id), "username": "recipient", "username_lower": "recipient"})

    result = asyncio.run(
        create_conversation(
            ConversationCreateRequest(kind="direct", recipient_id=recipient.id),
            user=sender,
            database=db,
        )
    )

    assert result.kind == "direct"
    assert len(db.conversations.inserted) == 1
    memberships = [m for m in db.conversation_memberships.inserted if m["conversation_id"] == ObjectId(result.id)]
    assert len(memberships) == 2
    roles = {str(m["user_id"]): m["role"] for m in memberships}
    assert roles[sender.id] == "owner"
    assert roles[recipient.id] == "member"


def test_create_direct_conversation_rejects_missing_recipient() -> None:
    db = MockDatabase()
    sender = make_user("sender")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            create_conversation(
                ConversationCreateRequest(kind="direct"),
                user=sender,
                database=db,
            )
        )
    assert exc.value.status_code == 400
    assert "recipient" in exc.value.detail.lower()


def test_create_direct_conversation_rejects_self() -> None:
    db = MockDatabase()
    sender = make_user("sender")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            create_conversation(
                ConversationCreateRequest(kind="direct", recipient_id=sender.id),
                user=sender,
                database=db,
            )
        )
    assert exc.value.status_code == 400
    assert "yourself" in exc.value.detail.lower()


def test_create_direct_conversation_rejects_nonexistent_recipient() -> None:
    db = MockDatabase()
    sender = make_user("sender")
    fake_recipient_id = str(ObjectId())

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            create_conversation(
                ConversationCreateRequest(kind="direct", recipient_id=fake_recipient_id),
                user=sender,
                database=db,
            )
        )
    assert exc.value.status_code == 404
    assert "recipient not found" in exc.value.detail.lower()


def test_create_direct_conversation_reuses_existing() -> None:
    db = MockDatabase()
    sender = make_user("sender")
    recipient = make_user("recipient")
    db.users.items.append({"_id": ObjectId(recipient.id), "username": "recipient", "username_lower": "recipient"})

    conv1 = asyncio.run(
        create_conversation(
            ConversationCreateRequest(kind="direct", recipient_id=recipient.id),
            user=sender,
            database=db,
        )
    )

    conv2 = asyncio.run(
        create_conversation(
            ConversationCreateRequest(kind="direct", recipient_id=recipient.id),
            user=sender,
            database=db,
        )
    )

    assert conv1.id == conv2.id
    assert len(db.conversations.items) == 1


# 3. Group Conversations
def test_create_group_conversation_with_multiple_participants() -> None:
    db = MockDatabase()
    owner = make_user("owner")
    p1 = make_user("p1")
    p2 = make_user("p2")
    db.users.items.extend([
        {"_id": ObjectId(p1.id), "username": "p1"},
        {"_id": ObjectId(p2.id), "username": "p2"},
    ])

    result = asyncio.run(
        create_conversation(
            ConversationCreateRequest(kind="group", participant_ids=[p1.id, p2.id], title="Team Project"),
            user=owner,
            database=db,
        )
    )

    assert result.kind == "group"
    assert result.title == "Team Project"
    memberships = [m for m in db.conversation_memberships.inserted if m["conversation_id"] == ObjectId(result.id)]
    assert len(memberships) == 3


def test_create_group_conversation_rejects_invalid_participant_id() -> None:
    db = MockDatabase()
    owner = make_user("owner")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            create_conversation(
                ConversationCreateRequest(kind="group", participant_ids=["not-an-id"]),
                user=owner,
                database=db,
            )
        )
    assert exc.value.status_code == 400


def test_create_group_conversation_rejects_nonexistent_participant() -> None:
    db = MockDatabase()
    owner = make_user("owner")
    fake_pid = str(ObjectId())

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            create_conversation(
                ConversationCreateRequest(kind="group", participant_ids=[fake_pid]),
                user=owner,
                database=db,
            )
        )
    assert exc.value.status_code == 404


def test_create_group_conversation_enforces_participant_limit() -> None:
    db = MockDatabase()
    owner = make_user("owner")
    oversized_pids = [str(ObjectId()) for _ in range(51)]

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            create_conversation(
                ConversationCreateRequest(kind="group", participant_ids=oversized_pids),
                user=owner,
                database=db,
            )
        )
    assert exc.value.status_code == 400
    assert "exceed 50" in exc.value.detail.lower()


# 4. Adding Members to Existing Group
def test_add_member_to_group_by_username_success(monkeypatch: pytest.MonkeyPatch) -> None:
    db = MockDatabase()
    owner = make_user("owner")
    invitee = make_user("invitee")
    db.users.items.append({"_id": ObjectId(invitee.id), "username": "invitee", "username_lower": "invitee"})

    conv_id = ObjectId()
    db.conversations.items.append({"_id": conv_id, "kind": "group", "owner_id": ObjectId(owner.id), "created_at": datetime.now(timezone.utc), "updated_at": datetime.now(timezone.utc)})
    db.conversation_memberships.items.append({"_id": ObjectId(), "conversation_id": conv_id, "user_id": ObjectId(owner.id), "role": "owner", "created_at": datetime.now(timezone.utc)})

    published_events: list[dict] = []
    async def fake_publish(user_ids: list[ObjectId], event: dict) -> None:
        published_events.append(event)
    monkeypatch.setattr("app.routes.conversations.publish", fake_publish)

    member_reply = asyncio.run(
        add_member(
            AddMemberRequest(username="invitee"),
            raw_id=str(conv_id),
            user=owner,
            database=db,
        )
    )

    assert member_reply.username == "invitee"
    assert member_reply.role == "member"
    assert len(published_events) == 1
    assert published_events[0]["type"] == "member_joined"
    assert published_events[0]["user"]["username"] == "invitee"


def test_add_member_rejects_direct_conversation() -> None:
    db = MockDatabase()
    user1 = make_user("user1")
    user2 = make_user("user2")
    db.users.items.append({"_id": ObjectId(user2.id), "username": "user2", "username_lower": "user2"})

    conv_id = ObjectId()
    db.conversations.items.append({"_id": conv_id, "kind": "direct", "owner_id": ObjectId(user1.id), "created_at": datetime.now(timezone.utc), "updated_at": datetime.now(timezone.utc)})
    db.conversation_memberships.items.append({"_id": ObjectId(), "conversation_id": conv_id, "user_id": ObjectId(user1.id), "role": "owner", "created_at": datetime.now(timezone.utc)})

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            add_member(
                AddMemberRequest(username="user2"),
                raw_id=str(conv_id),
                user=user1,
                database=db,
            )
        )
    assert exc.value.status_code == 400
    assert "direct conversation" in exc.value.detail.lower()


def test_add_member_rejects_non_member() -> None:
    db = MockDatabase()
    owner = make_user("owner")
    outsider = make_user("outsider")
    invitee = make_user("invitee")

    conv_id = ObjectId()
    db.conversations.items.append({"_id": conv_id, "kind": "group", "owner_id": ObjectId(owner.id), "created_at": datetime.now(timezone.utc), "updated_at": datetime.now(timezone.utc)})
    db.conversation_memberships.items.append({"_id": ObjectId(), "conversation_id": conv_id, "user_id": ObjectId(owner.id), "role": "owner", "created_at": datetime.now(timezone.utc)})

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            add_member(
                AddMemberRequest(username="invitee"),
                raw_id=str(conv_id),
                user=outsider,
                database=db,
            )
        )
    assert exc.value.status_code == 404


def test_add_member_rejects_already_member() -> None:
    db = MockDatabase()
    owner = make_user("owner")
    member = make_user("member")
    db.users.items.append({"_id": ObjectId(member.id), "username": "member", "username_lower": "member"})

    conv_id = ObjectId()
    db.conversations.items.append({"_id": conv_id, "kind": "group", "owner_id": ObjectId(owner.id), "created_at": datetime.now(timezone.utc), "updated_at": datetime.now(timezone.utc)})
    db.conversation_memberships.items.extend([
        {"_id": ObjectId(), "conversation_id": conv_id, "user_id": ObjectId(owner.id), "role": "owner", "created_at": datetime.now(timezone.utc)},
        {"_id": ObjectId(), "conversation_id": conv_id, "user_id": ObjectId(member.id), "role": "member", "created_at": datetime.now(timezone.utc)},
    ])

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            add_member(
                AddMemberRequest(username="member"),
                raw_id=str(conv_id),
                user=owner,
                database=db,
            )
        )
    assert exc.value.status_code == 409
    assert "already a member" in exc.value.detail.lower()


def test_list_members_returns_all_participants() -> None:
    db = MockDatabase()
    owner = make_user("owner")
    member = make_user("member")
    db.users.items.extend([
        {"_id": ObjectId(owner.id), "username": "owner"},
        {"_id": ObjectId(member.id), "username": "member"},
    ])

    conv_id = ObjectId()
    db.conversations.items.append({"_id": conv_id, "kind": "group", "owner_id": ObjectId(owner.id), "created_at": datetime.now(timezone.utc), "updated_at": datetime.now(timezone.utc)})
    db.conversation_memberships.items.extend([
        {"_id": ObjectId(), "conversation_id": conv_id, "user_id": ObjectId(owner.id), "role": "owner", "created_at": datetime.now(timezone.utc)},
        {"_id": ObjectId(), "conversation_id": conv_id, "user_id": ObjectId(member.id), "role": "member", "created_at": datetime.now(timezone.utc)},
    ])

    members = asyncio.run(list_members(raw_id=str(conv_id), user=owner, database=db))
    assert len(members) == 2
    roles = {m.username: m.role for m in members}
    assert roles["owner"] == "owner"
    assert roles["member"] == "member"


def test_newly_added_member_can_access_history_and_receive_broadcast(monkeypatch: pytest.MonkeyPatch) -> None:
    db = MockDatabase()
    owner = make_user("owner")
    new_member = make_user("new_member")
    db.users.items.extend([
        {"_id": ObjectId(owner.id), "username": "owner"},
        {"_id": ObjectId(new_member.id), "username": "new_member", "username_lower": "new_member"},
    ])

    conv_id = ObjectId()
    now = datetime.now(timezone.utc)
    db.conversations.items.append({"_id": conv_id, "kind": "group", "owner_id": ObjectId(owner.id), "created_at": now, "updated_at": now})
    db.conversation_memberships.items.append({"_id": ObjectId(), "conversation_id": conv_id, "user_id": ObjectId(owner.id), "role": "owner", "created_at": now})

    # Owner posted a message before new_member was added
    db.messages.items.append({
        "_id": ObjectId(),
        "conversation_id": conv_id,
        "sender_id": ObjectId(owner.id),
        "content": "welcome pre-existing message",
        "client_id": str(uuid4()),
        "created_at": now,
    })

    # Initially new_member cannot read messages (HTTP 404)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(list_messages(conversation_id=str(conv_id), user=new_member, database=db))
    assert exc.value.status_code == 404

    # Add new_member to group
    asyncio.run(add_member(AddMemberRequest(username="new_member"), raw_id=str(conv_id), user=owner, database=db))

    # Now new_member can read message history
    history = asyncio.run(list_messages(conversation_id=str(conv_id), user=new_member, database=db))
    assert len(history) == 1
    assert history[0].content == "welcome pre-existing message"

    # Now owner sends another message -> verified that new_member is among broadcast recipients
    broadcast_recipients: list[ObjectId] = []
    async def fake_publish(user_ids: list[ObjectId], event: dict) -> None:
        broadcast_recipients.extend(user_ids)
    monkeypatch.setattr("app.routes.messages.publish", fake_publish)

    asyncio.run(
        create_message(
            MessageCreateRequest(content="message after join"),
            conversation_id=str(conv_id),
            user=owner,
            database=db,
        )
    )

    assert ObjectId(new_member.id) in broadcast_recipients
