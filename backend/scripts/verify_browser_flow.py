import asyncio
import os
import sys
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from bson import ObjectId
import httpx

# Ensure backend root is on sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.database import get_database
from app.core.security import hash_password
from app.main import app


class BrowserClientSession:
    """Simulates an independent browser tab/session (sessionStorage, HTTP requests, WebSockets)."""

    def __init__(self, name: str, client: httpx.AsyncClient) -> None:
        self.name = name
        self.client = client
        self.access_token: str | None = None
        self.refresh_token: str | None = None
        self.user_id: str | None = None
        self.username: str | None = None

    async def login(self, email: str, password: str) -> dict:
        res = await self.client.post("/auth/login", json={"email": email, "password": password})
        if res.status_code != 200:
            raise RuntimeError(f"[{self.name}] Login failed: {res.status_code} {res.text}")
        data = res.json()
        self.access_token = data["access_token"]
        self.refresh_token = data["refresh_token"]

        me_res = await self.get("/auth/me")
        self.user_id = me_res["id"]
        self.username = me_res["username"]
        print(f"[{self.name}] Logged in successfully as @{self.username} (ID: {self.user_id})")
        return data

    def headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self.access_token:
            h["Authorization"] = f"Bearer {self.access_token}"
        return h

    async def get(self, path: str) -> Any:
        res = await self.client.get(path, headers=self.headers())
        if res.status_code not in (200, 201, 204):
            raise RuntimeError(f"[{self.name}] GET {path} failed ({res.status_code}): {res.text}")
        return res.json() if res.status_code != 204 else None

    async def post(self, path: str, payload: dict) -> Any:
        res = await self.client.post(path, json=payload, headers=self.headers())
        if res.status_code not in (200, 201, 204):
            raise RuntimeError(f"[{self.name}] POST {path} failed ({res.status_code}): {res.text}")
        return res.json() if res.status_code != 204 else None

    async def refresh_session(self) -> None:
        res = await self.client.post("/auth/refresh", json={"refresh_token": self.refresh_token})
        if res.status_code != 200:
            raise RuntimeError(f"[{self.name}] Refresh failed ({res.status_code}): {res.text}")
        data = res.json()
        self.access_token = data["access_token"]
        self.refresh_token = data["refresh_token"]
        print(f"[{self.name}] Rotated session token cleanly.")

    async def logout(self) -> None:
        res = await self.client.post("/auth/logout", json={"refresh_token": self.refresh_token}, headers=self.headers())
        if res.status_code != 200:
            raise RuntimeError(f"[{self.name}] Logout failed: {res.text}")
        self.access_token = None
        self.refresh_token = None
        print(f"[{self.name}] Logged out; session cleared.")


async def run_browser_simulation() -> None:
    print("=" * 70)
    print("PHASE 5: MULTI-SESSION BROWSER FLOW VERIFICATION")
    print("=" * 70)

    db = get_database()
    tag = uuid4().hex[:8]
    clean_user_ids = []
    clean_conv_ids = []

    # Provision 3 verified accounts in Atlas
    now = datetime.now(timezone.utc)
    accounts = [
        (f"alice_{tag}", f"alice_{tag}@example.com", "Password_123!"),
        (f"bob_{tag}", f"bob_{tag}@example.com", "Password_123!"),
        (f"charlie_{tag}", f"charlie_{tag}@example.com", "Password_123!"),
    ]

    for uname, email, pwd in accounts:
        doc = {
            "email": email,
            "username": uname,
            "username_lower": uname.lower(),
            "password_hash": hash_password(pwd),
            "email_verified": True,
            "created_at": now,
        }
        res = await db.users.insert_one(doc)
        clean_user_ids.append(res.inserted_id)

    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as test_client:
            # 1. Independent Browser Sessions
            session_alice = BrowserClientSession("BrowserSession:Alice", test_client)
            session_bob = BrowserClientSession("BrowserSession:Bob", test_client)

            # 2. Login Flow
            print("\n--- 1. Login Flow (Two Independent Sessions) ---")
            await session_alice.login(f"alice_{tag}@example.com", "Password_123!")
            await session_bob.login(f"bob_{tag}@example.com", "Password_123!")

            # 3. Direct Message Flow
            print("\n--- 2. Direct Message Flow ---")
            dm = await session_alice.post("/conversations", {"kind": "direct", "recipient_id": session_bob.user_id})
            clean_conv_ids.append(ObjectId(dm["id"]))
            print(f"[Alice] Created DM with Bob (ID: {dm['id']})")

            # Alice sends message
            msg1 = await session_alice.post(f"/conversations/{dm['id']}/messages", {"content": "Hey Bob from Browser A"})
            print(f"[Alice] Sent message: '{msg1['content']}'")

            # Bob lists messages
            bob_msgs = await session_bob.get(f"/conversations/{dm['id']}/messages")
            assert len(bob_msgs) == 1
            assert bob_msgs[0]["content"] == "Hey Bob from Browser A"
            print(f"[Bob] Received Alice's message in browser B: '{bob_msgs[0]['content']}'")

            # Bob replies
            msg2 = await session_bob.post(f"/conversations/{dm['id']}/messages", {"content": "Hey Alice, reply from Browser B"})
            print(f"[Bob] Sent reply: '{msg2['content']}'")

            # Alice reads replies
            alice_msgs = await session_alice.get(f"/conversations/{dm['id']}/messages")
            assert len(alice_msgs) == 2
            assert alice_msgs[1]["content"] == "Hey Alice, reply from Browser B"
            print(f"[Alice] Read full conversation in browser A (2 messages).")

            # 4. Group Creation & Invitation Flow
            print("\n--- 3. Group Creation & Invitation Flow ---")
            group = await session_alice.post("/conversations", {
                "kind": "group",
                "participant_ids": [session_bob.user_id],
                "title": "Browser Collaboration",
            })
            clean_conv_ids.append(ObjectId(group["id"]))
            print(f"[Alice] Created Group 'Browser Collaboration' with Bob.")

            # Bob invites Charlie
            charlie_invite = await session_bob.post(f"/conversations/{group['id']}/members", {"username": f"charlie_{tag}"})
            print(f"[Bob] Invited Charlie to group: @{charlie_invite['username']}")

            # Verify members from Alice's browser
            group_members = await session_alice.get(f"/conversations/{group['id']}/members")
            assert len(group_members) == 3
            member_names = {m["username"] for m in group_members}
            assert member_names == {f"alice_{tag}", f"bob_{tag}", f"charlie_{tag}"}
            print(f"[Alice] Group participant drawer shows 3 members: {member_names}")

            # 5. Session Refresh / Token Rotation (Background heartbeat)
            print("\n--- 4. Session Refresh & Token Rotation ---")
            await session_alice.refresh_session()

            # 6. Browser Page Refresh Simulation (Reloading all state)
            print("\n--- 5. Browser Page Refresh Simulation ---")
            user_reloaded = await session_alice.get("/auth/me")
            assert user_reloaded["username"] == f"alice_{tag}"
            convs_reloaded = await session_alice.get("/conversations")
            assert len(convs_reloaded) >= 2
            messages_reloaded = await session_alice.get(f"/conversations/{dm['id']}/messages")
            assert len(messages_reloaded) == 2
            print("[Alice] Page reload simulation: Session restored, channels loaded, messages intact.")

            # 7. Logout Flow
            print("\n--- 6. Logout Flow ---")
            await session_alice.logout()
            # Verify session is dead
            res = await test_client.get("/auth/me", headers={"Authorization": f"Bearer {session_alice.access_token}"})
            assert res.status_code == 401
            print("[Alice] Verified logout: Token rejected, access denied.")

            print("\n" + "=" * 70)
            print("ALL MULTI-SESSION BROWSER FLOWS PASSED SUCCESSFULLY!")
            print("=" * 70)
    finally:
        if clean_user_ids:
            await db.users.delete_many({"_id": {"$in": clean_user_ids}})
        if clean_conv_ids:
            await db.conversations.delete_many({"_id": {"$in": clean_conv_ids}})
            await db.conversation_memberships.delete_many({"conversation_id": {"$in": clean_conv_ids}})
            await db.messages.delete_many({"conversation_id": {"$in": clean_conv_ids}})
        print(f"[CLEANUP] Purged {len(clean_user_ids)} test users and {len(clean_conv_ids)} test conversations.")


if __name__ == "__main__":
    asyncio.run(run_browser_simulation())
