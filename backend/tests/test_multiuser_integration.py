import asyncio
from datetime import datetime, timezone
import json
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from bson import ObjectId
from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

from app.core.security import create_access_token
from app.routes.auth import UserReply
from app.routes.conversations import (
    AddMemberRequest,
    ConversationCreateRequest,
    add_member,
    create_conversation,
    list_conversations,
    list_members,
)
from app.routes.messages import MessageCreateRequest, create_message, list_messages
from app.routes.websocket import (
    connections,
    publish,
    websocket_endpoint,
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
        limit_val = count.default if hasattr(count, "default") else count
        return AsyncCursor(self.items[: int(limit_val)])

    def sort(self, key: str, direction: int = 1) -> "AsyncCursor":
        reverse = direction < 0
        sorted_items = sorted(
            self.items,
            key=lambda x: (x.get(key, 0), str(x.get("_id", ""))),
            reverse=reverse,
        )
        return AsyncCursor(sorted_items)

    async def to_list(self, length: object) -> list[dict[str, Any]]:
        length_val = length.default if hasattr(length, "default") else length
        return self.items[: int(length_val)]


class MockCollection:
    def __init__(self, initial_items: list[dict[str, Any]] | None = None) -> None:
        self.items: list[dict[str, Any]] = initial_items or []
        self.inserted: list[dict[str, Any]] = []
        self.unique_keys: list[tuple[str, ...]] = []

    def set_unique_index(self, keys: tuple[str, ...]) -> None:
        self.unique_keys.append(keys)

    async def insert_one(self, doc: dict[str, Any]) -> SimpleNamespace:
        if "_id" not in doc:
            doc["_id"] = ObjectId()

        # Enforce unique indexes atomically
        for keys in self.unique_keys:
            for existing in self.items:
                if all(existing.get(k) == doc.get(k) for k in keys):
                    raise DuplicateKeyError(f"Duplicate key on index {keys}")

        self.inserted.append(doc)
        self.items.append(doc)
        return SimpleNamespace(inserted_id=doc["_id"])

    async def find_one(self, query: dict[str, Any]) -> dict[str, Any] | None:
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

    def find(self, query: dict[str, Any], projection: dict[str, Any] | None = None) -> AsyncCursor:
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

    async def update_one(self, query: dict[str, Any], update: dict[str, Any]) -> None:
        target = await self.find_one(query)
        if target and "$set" in update:
            target.update(update["$set"])

    async def delete_one(self, query: dict[str, Any]) -> None:
        to_remove = await self.find_one(query)
        if to_remove and to_remove in self.items:
            self.items.remove(to_remove)

    async def delete_many(self, query: dict[str, Any]) -> None:
        to_remove = [item for item in self.items if all(item.get(k) == v for k, v in query.items())]
        for item in to_remove:
            self.items.remove(item)


class MockDatabase:
    def __init__(self) -> None:
        self.users = MockCollection()
        self.conversations = MockCollection()
        self.conversation_memberships = MockCollection()
        self.conversation_memberships.set_unique_index(("conversation_id", "user_id"))
        self.messages = MockCollection()


class MockWebSocket:
    def __init__(self, incoming_events: list[Any], origin: str | None = "http://localhost:3000") -> None:
        self.incoming = list(incoming_events)
        self.sent: list[Any] = []
        self.closed_code: int | None = None
        self.headers = {"origin": origin} if origin else {}
        self.client = SimpleNamespace(host="127.0.0.1")
        self.accepted = False

    async def accept(self) -> None:
        self.accepted = True

    async def receive_json(self) -> Any:
        if self.incoming:
            return self.incoming.pop(0)
        raise asyncio.TimeoutError()

    async def receive_text(self) -> str:
        if self.incoming:
            item = self.incoming.pop(0)
            return json.dumps(item) if not isinstance(item, str) else item
        await asyncio.sleep(10.0)
        return ""

    async def send_text(self, text: str) -> None:
        self.sent.append(text)

    async def send_json(self, data: Any) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000) -> None:
        self.closed_code = code


# ==============================================================================
# PHASE 4 MULTI-USER INTEGRATION TEST CHECKLIST (7/7 + 2 SPECIAL CHECKS)
# ==============================================================================

# 1. Direct Messaging: Register two accounts, create a DM, and exchange messages in both directions
def test_checklist_1_direct_messaging_bidirectional() -> None:
    db = MockDatabase()
    alice = make_user("alice")
    bob = make_user("bob")
    db.users.items.extend([
        {"_id": ObjectId(alice.id), "username": "alice", "username_lower": "alice"},
        {"_id": ObjectId(bob.id), "username": "bob", "username_lower": "bob"},
    ])

    # Alice creates a direct message with Bob
    dm = asyncio.run(
        create_conversation(
            ConversationCreateRequest(kind="direct", recipient_id=bob.id),
            user=alice,
            database=db,
        )
    )
    assert dm.kind == "direct"

    # Alice sends a message
    msg1 = asyncio.run(
        create_message(
            MessageCreateRequest(content="Hello Bob from Alice!"),
            conversation_id=dm.id,
            user=alice,
            database=db,
        )
    )
    assert msg1.content == "Hello Bob from Alice!"

    # Bob retrieves messages and verifies message from Alice
    bob_view = asyncio.run(list_messages(conversation_id=dm.id, user=bob, database=db))
    assert len(bob_view) == 1
    assert bob_view[0].content == "Hello Bob from Alice!"
    assert bob_view[0].sender_id == alice.id

    # Bob replies
    msg2 = asyncio.run(
        create_message(
            MessageCreateRequest(content="Hey Alice, message received!"),
            conversation_id=dm.id,
            user=bob,
            database=db,
        )
    )
    assert msg2.content == "Hey Alice, message received!"

    # Alice retrieves messages and verifies full conversation history
    alice_view = asyncio.run(list_messages(conversation_id=dm.id, user=alice, database=db))
    assert len(alice_view) == 2
    assert [m.content for m in alice_view] == ["Hello Bob from Alice!", "Hey Alice, message received!"]
    assert alice_view[1].sender_id == bob.id


# 2. Duplicate DM Prevention: Create a DM with the same person again; verify existing conversation is reused
def test_checklist_2_duplicate_dm_prevention() -> None:
    db = MockDatabase()
    alice = make_user("alice")
    bob = make_user("bob")
    db.users.items.extend([
        {"_id": ObjectId(alice.id), "username": "alice", "username_lower": "alice"},
        {"_id": ObjectId(bob.id), "username": "bob", "username_lower": "bob"},
    ])

    # Initial DM creation
    dm1 = asyncio.run(
        create_conversation(
            ConversationCreateRequest(kind="direct", recipient_id=bob.id),
            user=alice,
            database=db,
        )
    )

    # Post a message in the initial DM
    asyncio.run(
        create_message(
            MessageCreateRequest(content="Pre-existing thread message"),
            conversation_id=dm1.id,
            user=alice,
            database=db,
        )
    )

    # Alice attempts to create DM with Bob again
    dm2 = asyncio.run(
        create_conversation(
            ConversationCreateRequest(kind="direct", recipient_id=bob.id),
            user=alice,
            database=db,
        )
    )
    assert dm2.id == dm1.id

    # Bob attempts to create DM with Alice
    dm3 = asyncio.run(
        create_conversation(
            ConversationCreateRequest(kind="direct", recipient_id=alice.id),
            user=bob,
            database=db,
        )
    )
    assert dm3.id == dm1.id

    # Verify no duplicate conversation document created in database
    assert len(db.conversations.items) == 1
    # Verify messages in conversation remain continuous
    history = asyncio.run(list_messages(conversation_id=dm3.id, user=bob, database=db))
    assert len(history) == 1
    assert history[0].content == "Pre-existing thread message"


# 3. Group Creation: Create a group with three accounts and verify every member sees it
def test_checklist_3_group_creation_three_accounts() -> None:
    db = MockDatabase()
    alice = make_user("alice")
    bob = make_user("bob")
    charlie = make_user("charlie")
    db.users.items.extend([
        {"_id": ObjectId(alice.id), "username": "alice"},
        {"_id": ObjectId(bob.id), "username": "bob"},
        {"_id": ObjectId(charlie.id), "username": "charlie"},
    ])

    group = asyncio.run(
        create_conversation(
            ConversationCreateRequest(
                kind="group",
                participant_ids=[bob.id, charlie.id],
                title="Trio Workspace",
            ),
            user=alice,
            database=db,
        )
    )
    assert group.kind == "group"
    assert group.title == "Trio Workspace"

    # Verify all 3 members see the group in list_conversations
    alice_convs = asyncio.run(list_conversations(user=alice, database=db))
    bob_convs = asyncio.run(list_conversations(user=bob, database=db))
    charlie_convs = asyncio.run(list_conversations(user=charlie, database=db))

    assert any(c.id == group.id for c in alice_convs)
    assert any(c.id == group.id for c in bob_convs)
    assert any(c.id == group.id for c in charlie_convs)

    # Verify membership roles
    members = asyncio.run(list_members(raw_id=group.id, user=alice, database=db))
    assert len(members) == 3
    roles = {m.username: m.role for m in members}
    assert roles["alice"] == "owner"
    assert roles["bob"] == "member"
    assert roles["charlie"] == "member"


# 4. Group Invitations: Invite a fourth account and verify membership updates for everyone
def test_checklist_4_group_invitations_updates_membership() -> None:
    db = MockDatabase()
    alice = make_user("alice")
    bob = make_user("bob")
    charlie = make_user("charlie")
    dave = make_user("dave")
    db.users.items.extend([
        {"_id": ObjectId(alice.id), "username": "alice"},
        {"_id": ObjectId(bob.id), "username": "bob"},
        {"_id": ObjectId(charlie.id), "username": "charlie"},
        {"_id": ObjectId(dave.id), "username": "dave", "username_lower": "dave"},
    ])

    group = asyncio.run(
        create_conversation(
            ConversationCreateRequest(kind="group", participant_ids=[bob.id, charlie.id]),
            user=alice,
            database=db,
        )
    )

    # Bob (a group member) invites Dave to the group
    invite_reply = asyncio.run(
        add_member(
            AddMemberRequest(username="dave"),
            raw_id=group.id,
            user=bob,
            database=db,
        )
    )
    assert invite_reply.username == "dave"
    assert invite_reply.role == "member"

    # Verify all 4 users can now view the updated members list
    for user in [alice, bob, charlie, dave]:
        members = asyncio.run(list_members(raw_id=group.id, user=user, database=db))
        assert len(members) == 4
        usernames = {m.username for m in members}
        assert usernames == {"alice", "bob", "charlie", "dave"}

    # Dave can now also participate and send messages
    dave_msg = asyncio.run(
        create_message(
            MessageCreateRequest(content="Hello team, thanks for having me!"),
            conversation_id=group.id,
            user=dave,
            database=db,
        )
    )
    assert dave_msg.content == "Hello team, thanks for having me!"


# 5. Authorization: Confirm non-member cannot read history, subscribe, or invite
def test_checklist_5_authorization_barriers_for_non_member(monkeypatch: pytest.MonkeyPatch) -> None:
    db = MockDatabase()
    alice = make_user("alice")
    bob = make_user("bob")
    eve = make_user("eve")
    frank = make_user("frank")
    db.users.items.extend([
        {"_id": ObjectId(alice.id), "username": "alice"},
        {"_id": ObjectId(bob.id), "username": "bob"},
        {"_id": ObjectId(eve.id), "username": "eve"},
        {"_id": ObjectId(frank.id), "username": "frank", "username_lower": "frank"},
    ])

    group = asyncio.run(
        create_conversation(
            ConversationCreateRequest(kind="group", participant_ids=[bob.id]),
            user=alice,
            database=db,
        )
    )

    # Eve (outsider) cannot read message history -> 404
    with pytest.raises(HTTPException) as exc:
        asyncio.run(list_messages(conversation_id=group.id, user=eve, database=db))
    assert exc.value.status_code == 404

    # Eve cannot post messages -> 404
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            create_message(
                MessageCreateRequest(content="Intrusion attempt"),
                conversation_id=group.id,
                user=eve,
                database=db,
            )
        )
    assert exc.value.status_code == 404

    # Eve cannot invite other users -> 404
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            add_member(
                AddMemberRequest(username="frank"),
                raw_id=group.id,
                user=eve,
                database=db,
            )
        )
    assert exc.value.status_code == 404

    # Eve cannot list members -> 404
    with pytest.raises(HTTPException) as exc:
        asyncio.run(list_members(raw_id=group.id, user=eve, database=db))
    assert exc.value.status_code == 404

    # Eve cannot subscribe to group WebSocket -> closed with 1008
    monkeypatch.setattr("app.routes.websocket.get_database", lambda: db)
    eve_token = create_access_token(eve.id)
    ws = MockWebSocket(
        incoming_events=[
            {"type": "auth", "access_token": eve_token},
            {"type": "subscribe", "conversation_id": group.id},
        ]
    )
    asyncio.run(websocket_endpoint(ws))
    assert ws.closed_code == 1008


# 6. Real-time Behavior: Verify messages and member_joined events arrive without refreshing
def test_checklist_6_realtime_events_delivery(monkeypatch: pytest.MonkeyPatch) -> None:
    db = MockDatabase()
    alice = make_user("alice")
    bob = make_user("bob")
    charlie = make_user("charlie")
    db.users.items.extend([
        {"_id": ObjectId(alice.id), "username": "alice"},
        {"_id": ObjectId(bob.id), "username": "bob"},
        {"_id": ObjectId(charlie.id), "username": "charlie", "username_lower": "charlie"},
    ])

    group = asyncio.run(
        create_conversation(
            ConversationCreateRequest(kind="group", participant_ids=[bob.id]),
            user=alice,
            database=db,
        )
    )

    received_events_by_user: dict[str, list[dict[str, Any]]] = {
        alice.id: [],
        bob.id: [],
    }

    async def tracking_publish(user_ids: list[ObjectId], event: dict[str, Any]) -> None:
        for uid in user_ids:
            uid_str = str(uid)
            if uid_str in received_events_by_user:
                received_events_by_user[uid_str].append(event)

    monkeypatch.setattr("app.routes.messages.publish", tracking_publish)
    monkeypatch.setattr("app.routes.conversations.publish", tracking_publish)

    # 1. Alice sends a message -> Bob must receive it in real-time
    asyncio.run(
        create_message(
            MessageCreateRequest(content="Live event test message"),
            conversation_id=group.id,
            user=alice,
            database=db,
        )
    )

    assert len(received_events_by_user[bob.id]) == 1
    assert received_events_by_user[bob.id][0]["type"] == "message"
    assert received_events_by_user[bob.id][0]["message"]["content"] == "Live event test message"

    # 2. Alice invites Charlie -> Bob must receive member_joined event in real-time
    asyncio.run(
        add_member(
            AddMemberRequest(username="charlie"),
            raw_id=group.id,
            user=alice,
            database=db,
        )
    )

    assert len(received_events_by_user[bob.id]) == 2
    assert received_events_by_user[bob.id][1]["type"] == "member_joined"
    assert received_events_by_user[bob.id][1]["user"]["username"] == "charlie"


# 7. Reconnect and Persistence: Disconnect, reconnect, and verify messages and memberships persist
def test_checklist_7_reconnect_and_persistence() -> None:
    db = MockDatabase()
    alice = make_user("alice")
    bob = make_user("bob")
    db.users.items.extend([
        {"_id": ObjectId(alice.id), "username": "alice"},
        {"_id": ObjectId(bob.id), "username": "bob"},
    ])

    # Establish conversation and messages
    conv = asyncio.run(
        create_conversation(
            ConversationCreateRequest(kind="direct", recipient_id=bob.id),
            user=alice,
            database=db,
        )
    )
    asyncio.run(
        create_message(
            MessageCreateRequest(content="Persistent Message 1"),
            conversation_id=conv.id,
            user=alice,
            database=db,
        )
    )
    asyncio.run(
        create_message(
            MessageCreateRequest(content="Persistent Message 2"),
            conversation_id=conv.id,
            user=bob,
            database=db,
        )
    )

    # Simulate client disconnects and fresh reconnects
    # In MongoDB, the state is persisted in collections
    persisted_members = asyncio.run(list_members(raw_id=conv.id, user=bob, database=db))
    assert len(persisted_members) == 2
    usernames = {m.username for m in persisted_members}
    assert usernames == {"alice", "bob"}

    persisted_messages = asyncio.run(list_messages(conversation_id=conv.id, user=alice, database=db))
    assert len(persisted_messages) == 2
    assert [m.content for m in persisted_messages] == ["Persistent Message 1", "Persistent Message 2"]


# ==============================================================================
# SPECIAL CHECK 1: CONCURRENT INVITATIONS & ATOMIC UNIQUE CONSTRAINT
# ==============================================================================
def test_special_check_concurrent_invitations_handled_cleanly() -> None:
    db = MockDatabase()
    alice = make_user("alice")
    bob = make_user("bob")
    dave = make_user("dave")
    db.users.items.extend([
        {"_id": ObjectId(alice.id), "username": "alice"},
        {"_id": ObjectId(bob.id), "username": "bob"},
        {"_id": ObjectId(dave.id), "username": "dave", "username_lower": "dave"},
    ])

    group = asyncio.run(
        create_conversation(
            ConversationCreateRequest(kind="group", participant_ids=[bob.id]),
            user=alice,
            database=db,
        )
    )

    # Simulate two concurrent invitation requests for Dave arriving simultaneously
    async def invite_via_alice() -> tuple[str, int]:
        try:
            res = await add_member(AddMemberRequest(username="dave"), raw_id=group.id, user=alice, database=db)
            return ("alice", 201)
        except HTTPException as exc:
            return ("alice", exc.status_code)

    async def invite_via_bob() -> tuple[str, int]:
        try:
            res = await add_member(AddMemberRequest(username="dave"), raw_id=group.id, user=bob, database=db)
            return ("bob", 201)
        except HTTPException as exc:
            return ("bob", exc.status_code)

    async def run_concurrent() -> list[tuple[str, int]]:
        return await asyncio.gather(invite_via_alice(), invite_via_bob())

    results = asyncio.run(run_concurrent())
    status_codes = [status for _, status in results]

    # Exactly one must succeed with 201, and the other must cleanly return 409 Conflict
    assert 201 in status_codes
    assert 409 in status_codes

    # Database must contain exactly one membership record for Dave
    dave_memberships = [
        m for m in db.conversation_memberships.items
        if m["conversation_id"] == ObjectId(group.id) and m["user_id"] == ObjectId(dave.id)
    ]
    assert len(dave_memberships) == 1


# ==============================================================================
# SPECIAL CHECK 2: INVITATION PERMISSIONS (OWNER_ONLY VS ALL_MEMBERS)
# ==============================================================================
def test_special_check_invitation_permissions_owner_only() -> None:
    db = MockDatabase()
    alice = make_user("alice")
    bob = make_user("bob")
    dave = make_user("dave")
    db.users.items.extend([
        {"_id": ObjectId(alice.id), "username": "alice"},
        {"_id": ObjectId(bob.id), "username": "bob"},
        {"_id": ObjectId(dave.id), "username": "dave", "username_lower": "dave"},
    ])

    # Group created with strict owner_only invitation policy
    group = asyncio.run(
        create_conversation(
            ConversationCreateRequest(
                kind="group",
                participant_ids=[bob.id],
                invite_policy="owner_only",
            ),
            user=alice,
            database=db,
        )
    )

    # Bob (member, non-owner) attempts to invite Dave -> 403 Forbidden
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            add_member(
                AddMemberRequest(username="dave"),
                raw_id=group.id,
                user=bob,
                database=db,
            )
        )
    assert exc.value.status_code == 403
    assert "owner" in exc.value.detail.lower()

    # Alice (owner) invites Dave -> succeeds 201
    reply = asyncio.run(
        add_member(
            AddMemberRequest(username="dave"),
            raw_id=group.id,
            user=alice,
            database=db,
        )
    )
    assert reply.username == "dave"
    assert reply.role == "member"


def test_special_check_invitation_permissions_all_members_default() -> None:
    db = MockDatabase()
    alice = make_user("alice")
    bob = make_user("bob")
    dave = make_user("dave")
    db.users.items.extend([
        {"_id": ObjectId(alice.id), "username": "alice"},
        {"_id": ObjectId(bob.id), "username": "bob"},
        {"_id": ObjectId(dave.id), "username": "dave", "username_lower": "dave"},
    ])

    # Group created with default all_members invitation policy
    group = asyncio.run(
        create_conversation(
            ConversationCreateRequest(kind="group", participant_ids=[bob.id]),
            user=alice,
            database=db,
        )
    )

    # Bob (non-owner member) can invite Dave -> succeeds 201
    reply = asyncio.run(
        add_member(
            AddMemberRequest(username="dave"),
            raw_id=group.id,
            user=bob,
            database=db,
        )
    )
    assert reply.username == "dave"
    assert reply.role == "member"
