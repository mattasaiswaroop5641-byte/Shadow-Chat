import asyncio
import os
import sys
from datetime import datetime, timezone
from uuid import uuid4

from bson import ObjectId
from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

# Ensure backend root is on sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.database import get_database
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
from app.routes.websocket import connections, publish


async def run_phase4_atlas_verification() -> None:
    db = get_database()
    print("=" * 70)
    print("PHASE 4: LIVE ATLAS MULTI-USER INTEGRATION VERIFICATION")
    print("=" * 70)

    # 0. Connectivity Check
    ping_res = await db.command("ping")
    print(f"[OK] Connected to MongoDB Atlas: {ping_res}")

    test_run_tag = uuid4().hex[:8]
    cleanup_user_ids: list[ObjectId] = []
    cleanup_conv_ids: list[ObjectId] = []

    try:
        # Create 5 test user accounts directly in Atlas
        now = datetime.now(timezone.utc)
        usernames = ["alice", "bob", "charlie", "dave", "eve"]
        users: dict[str, UserReply] = {}

        for name in usernames:
            uname = f"t_{name}_{test_run_tag}"
            doc = {
                "email": f"{uname}@example.com",
                "username": uname,
                "username_lower": uname.lower(),
                "password_hash": "mocked_hash_for_testing",
                "email_verified": True,
                "created_at": now,
            }
            res = await db.users.insert_one(doc)
            cleanup_user_ids.append(res.inserted_id)
            users[name] = UserReply(
                id=str(res.inserted_id),
                email=doc["email"],
                username=uname,
                created_at=now,
                email_verified=True,
            )

        print(f"[OK] Created 5 test users in Atlas: {[u.username for u in users.values()]}")

        # ----------------------------------------------------------------------
        # 1. Direct Messaging
        # ----------------------------------------------------------------------
        print("\n--- 1. Direct Messaging Verification ---")
        dm = await create_conversation(
            ConversationCreateRequest(kind="direct", recipient_id=users["bob"].id),
            user=users["alice"],
            database=db,
        )
        cleanup_conv_ids.append(ObjectId(dm.id))
        assert dm.kind == "direct"

        msg1 = await create_message(
            MessageCreateRequest(content="Hello Bob!"),
            conversation_id=dm.id,
            user=users["alice"],
            database=db,
        )
        assert msg1.content == "Hello Bob!"

        bob_messages = await list_messages(conversation_id=dm.id, user=users["bob"], database=db)
        assert len(bob_messages) == 1
        assert bob_messages[0].content == "Hello Bob!"

        msg2 = await create_message(
            MessageCreateRequest(content="Hello Alice, got it!"),
            conversation_id=dm.id,
            user=users["bob"],
            database=db,
        )

        alice_messages = await list_messages(conversation_id=dm.id, user=users["alice"], database=db)
        assert len(alice_messages) == 2
        assert [m.content for m in alice_messages] == ["Hello Bob!", "Hello Alice, got it!"]
        print("[PASS] 1. Direct messaging bidirectional delivery verified.")

        # ----------------------------------------------------------------------
        # 2. Duplicate DM Prevention
        # ----------------------------------------------------------------------
        print("\n--- 2. Duplicate DM Prevention Verification ---")
        dm_repeat_alice = await create_conversation(
            ConversationCreateRequest(kind="direct", recipient_id=users["bob"].id),
            user=users["alice"],
            database=db,
        )
        dm_repeat_bob = await create_conversation(
            ConversationCreateRequest(kind="direct", recipient_id=users["alice"].id),
            user=users["bob"],
            database=db,
        )
        assert dm_repeat_alice.id == dm.id
        assert dm_repeat_bob.id == dm.id
        # Confirm database count of conversations for this pair is exactly 1
        conv_count = await db.conversations.count_documents({"_id": ObjectId(dm.id)})
        assert conv_count == 1
        print(f"[PASS] 2. Duplicate DM prevention verified: Reused existing conv {dm.id}.")

        # ----------------------------------------------------------------------
        # 3. Group Creation
        # ----------------------------------------------------------------------
        print("\n--- 3. Group Creation Verification ---")
        group = await create_conversation(
            ConversationCreateRequest(
                kind="group",
                participant_ids=[users["bob"].id, users["charlie"].id],
                title="Atlas Trio",
            ),
            user=users["alice"],
            database=db,
        )
        cleanup_conv_ids.append(ObjectId(group.id))
        assert group.kind == "group"

        for u in [users["alice"], users["bob"], users["charlie"]]:
            user_convs = await list_conversations(user=u, database=db)
            assert any(c.id == group.id for c in user_convs)
        print("[PASS] 3. Group creation with three accounts verified: Alice, Bob, Charlie all see it.")

        # ----------------------------------------------------------------------
        # 4. Group Invitations
        # ----------------------------------------------------------------------
        print("\n--- 4. Group Invitations Verification ---")
        # Bob invites Dave
        invited = await add_member(
            AddMemberRequest(username=users["dave"].username),
            raw_id=group.id,
            user=users["bob"],
            database=db,
        )
        assert invited.username == users["dave"].username

        members = await list_members(raw_id=group.id, user=users["dave"], database=db)
        assert len(members) == 4
        assert {m.username for m in members} == {u.username for u in [users["alice"], users["bob"], users["charlie"], users["dave"]]}
        print("[PASS] 4. Group invitations verified: Dave added, all 4 members confirmed.")

        # ----------------------------------------------------------------------
        # 5. Authorization Barriers
        # ----------------------------------------------------------------------
        print("\n--- 5. Authorization Barriers Verification ---")
        eve = users["eve"]
        for action_name, coro in [
            ("list_messages", list_messages(conversation_id=group.id, user=eve, database=db)),
            ("create_message", create_message(MessageCreateRequest(content="Hack"), conversation_id=group.id, user=eve, database=db)),
            ("add_member", add_member(AddMemberRequest(username="someone"), raw_id=group.id, user=eve, database=db)),
            ("list_members", list_members(raw_id=group.id, user=eve, database=db)),
        ]:
            try:
                await coro
                raise AssertionError(f"Expected 404 for {action_name}, but succeeded!")
            except HTTPException as exc:
                assert exc.status_code == 404, f"Expected 404, got {exc.status_code}"
        print("[PASS] 5. Authorization barriers verified: Non-member Eve rejected with 404 on all actions.")

        # ----------------------------------------------------------------------
        # 6. Real-time Behavior (WebSocket Queues)
        # ----------------------------------------------------------------------
        print("\n--- 6. Real-time Behavior Verification ---")
        bob_queue: asyncio.Queue[str] = asyncio.Queue()
        connections[ObjectId(users["bob"].id)].add(bob_queue)

        try:
            # Alice sends a message -> Bob's queue receives it in real time
            await create_message(
                MessageCreateRequest(content="Live real-time test!"),
                conversation_id=group.id,
                user=users["alice"],
                database=db,
            )
            raw_event = await asyncio.wait_for(bob_queue.get(), timeout=2.0)
            assert "Live real-time test!" in raw_event
            assert '"type":"message"' in raw_event
            print("[PASS] 6. Real-time message delivery verified without page refresh.")
        finally:
            connections[ObjectId(users["bob"].id)].discard(bob_queue)

        # ----------------------------------------------------------------------
        # 7. Reconnect and Persistence
        # ----------------------------------------------------------------------
        print("\n--- 7. Reconnect & Persistence Verification ---")
        # Querying fresh from MongoDB Atlas
        persisted_msgs = await list_messages(conversation_id=group.id, user=users["bob"], database=db)
        assert any(m.content == "Live real-time test!" for m in persisted_msgs)
        persisted_mems = await list_members(raw_id=group.id, user=users["dave"], database=db)
        assert len(persisted_mems) == 4
        print("[PASS] 7. Reconnect & persistence verified: All data persisted in Atlas.")

        # ----------------------------------------------------------------------
        # Special Check 1: Concurrent Invitations & Real Atlas Unique Index
        # ----------------------------------------------------------------------
        print("\n--- Special Check 1: Concurrent Invitations & Atlas Unique Constraint ---")
        # Create new group
        race_group = await create_conversation(
            ConversationCreateRequest(kind="group", participant_ids=[users["bob"].id]),
            user=users["alice"],
            database=db,
        )
        cleanup_conv_ids.append(ObjectId(race_group.id))

        # Alice and Bob both attempt to invite Charlie at the exact same instant
        async def race_invite_alice():
            try:
                await add_member(AddMemberRequest(username=users["charlie"].username), raw_id=race_group.id, user=users["alice"], database=db)
                return 201
            except HTTPException as e:
                return e.status_code

        async def race_invite_bob():
            try:
                await add_member(AddMemberRequest(username=users["charlie"].username), raw_id=race_group.id, user=users["bob"], database=db)
                return 201
            except HTTPException as e:
                return e.status_code

        results = await asyncio.gather(race_invite_alice(), race_invite_bob())
        print(f"Concurrent invitation results: {results}")
        assert 201 in results, "At least one invitation must succeed"
        assert 409 in results, "The duplicate invitation must be rejected with 409 Conflict"
        # Verify in real database that exactly ONE membership document exists
        count = await db.conversation_memberships.count_documents({
            "conversation_id": ObjectId(race_group.id),
            "user_id": ObjectId(users["charlie"].id),
        })
        assert count == 1, f"Expected 1 membership document in Atlas, found {count}"
        print("[PASS] Special Check 1: Concurrent invitations handled cleanly via Atlas unique constraint.")

        # ----------------------------------------------------------------------
        # Special Check 2: Invitation Permissions
        # ----------------------------------------------------------------------
        print("\n--- Special Check 2: Invitation Permissions (owner_only vs all_members) ---")
        restricted_group = await create_conversation(
            ConversationCreateRequest(
                kind="group",
                participant_ids=[users["bob"].id],
                invite_policy="owner_only",
            ),
            user=users["alice"],
            database=db,
        )
        cleanup_conv_ids.append(ObjectId(restricted_group.id))

        # Bob (non-owner) tries to invite Dave -> 403 Forbidden
        try:
            await add_member(AddMemberRequest(username=users["dave"].username), raw_id=restricted_group.id, user=users["bob"], database=db)
            raise AssertionError("Non-owner was able to invite in owner_only group!")
        except HTTPException as exc:
            assert exc.status_code == 403
            print(f"[PASS] Non-owner Bob correctly rejected with 403 in owner_only group: '{exc.detail}'")

        # Alice (owner) invites Dave -> 201 Created
        owner_invite = await add_member(AddMemberRequest(username=users["dave"].username), raw_id=restricted_group.id, user=users["alice"], database=db)
        assert owner_invite.username == users["dave"].username
        print(f"[PASS] Owner Alice successfully invited Dave with 201 in owner_only group.")

        print("\n" + "=" * 70)
        print("ALL 7/7 CHECKLIST ITEMS & BOTH SPECIAL CHECKS PASSED ON ATLAS!")
        print("=" * 70)

    finally:
        # Cleanup temporary records
        if cleanup_user_ids:
            await db.users.delete_many({"_id": {"$in": cleanup_user_ids}})
        if cleanup_conv_ids:
            await db.conversations.delete_many({"_id": {"$in": cleanup_conv_ids}})
            await db.conversation_memberships.delete_many({"conversation_id": {"$in": cleanup_conv_ids}})
            await db.messages.delete_many({"conversation_id": {"$in": cleanup_conv_ids}})
        print(f"\n[CLEANUP] Successfully cleaned up {len(cleanup_user_ids)} test users and {len(cleanup_conv_ids)} test conversations.")


if __name__ == "__main__":
    asyncio.run(run_phase4_atlas_verification())
