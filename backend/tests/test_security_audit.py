import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from bson import ObjectId
from fastapi import HTTPException
from pydantic import ValidationError
from starlette.requests import Request

from app.core.config import get_settings
from app.core.security import create_access_token, create_refresh_token, decode_token, hash_password, token_hash
from app.main import app, RequestSizeLimitMiddleware
from app.routes.auth import (
    LoginRequest,
    PasswordResetRequest,
    RefreshRequest,
    RegisterRequest,
    UserReply,
    VerifyEmailRequest,
    hash_otp,
    issue_tokens,
    login,
    logout,
    refresh,
    reset_password,
    verify_email,
)
from app.routes.conversations import (
    AddMemberRequest,
    ConversationCreateRequest,
    add_member,
    create_conversation,
    get_conversation,
    list_conversations,
    list_members,
)
from app.routes.messages import MessageCreateRequest, create_message, list_messages
from app.routes.users import search_users
from app.routes.websocket import (
    MAX_EVENT_BYTES,
    MAX_MESSAGES_PER_CONNECTION,
    MESSAGE_WINDOW_SECONDS,
    connections,
    websocket_endpoint,
)

settings = get_settings()


def make_request(path: str = "/", client_ip: str = "127.0.0.1", headers: list[tuple[bytes, bytes]] | None = None) -> Request:
    scope = {
        "type": "http",
        "method": "POST",
        "path": path,
        "headers": headers or [],
        "client": (client_ip, 12345),
    }
    return Request(scope)


def make_user(username: str, user_id: ObjectId | None = None, email_verified: bool = True) -> UserReply:
    uid = user_id or ObjectId()
    return UserReply(
        id=str(uid),
        email=f"{username}@example.com",
        username=username,
        created_at=datetime.now(timezone.utc),
        email_verified=email_verified,
    )


class AsyncCursor:
    def __init__(self, items: list[dict[str, Any]]) -> None:
        self.items = items

    def limit(self, count: object) -> "AsyncCursor":
        limit_val = count.default if hasattr(count, "default") else count
        return AsyncCursor(self.items[: int(limit_val)])

    def sort(self, key: str, direction: int = 1) -> "AsyncCursor":
        reverse = direction < 0
        sorted_items = sorted(self.items, key=lambda x: x.get(key, 0), reverse=reverse)
        return AsyncCursor(sorted_items)

    async def to_list(self, length: object) -> list[dict[str, Any]]:
        length_val = length.default if hasattr(length, "default") else length
        return self.items[: int(length_val)]


class MockCollection:
    def __init__(self, initial_items: list[dict[str, Any]] | None = None) -> None:
        self.items: list[dict[str, Any]] = initial_items or []

    async def insert_one(self, doc: dict[str, Any]) -> SimpleNamespace:
        if "_id" not in doc:
            doc["_id"] = ObjectId()
        self.items.append(doc)
        return SimpleNamespace(inserted_id=doc["_id"])

    async def find_one(self, query: dict[str, Any], sort: Any = None) -> dict[str, Any] | None:
        matched = []
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
                elif k == "_id" and isinstance(v, dict) and "$in" in v:
                    if item.get(k) not in v["$in"]:
                        match = False
                        break
                elif k == "conversation_id" and isinstance(v, dict) and "$in" in v:
                    if item.get(k) not in v["$in"]:
                        match = False
                        break
                elif item.get(k) != v:
                    match = False
                    break
            if match:
                matched.append(item)
        if not matched:
            return None
        return matched[-1] if sort else matched[0]

    async def find_one_and_delete(self, query: dict[str, Any]) -> dict[str, Any] | None:
        doc = await self.find_one(query)
        if doc and doc in self.items:
            self.items.remove(doc)
            return doc
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
                elif k == "username_lower" and isinstance(v, dict) and "$regex" in v:
                    prefix = v["$regex"].lstrip("^")
                    if not item.get("username_lower", "").startswith(prefix):
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
        if target:
            if "$set" in update:
                target.update(update["$set"])
            if "$inc" in update:
                for k, v in update["$inc"].items():
                    target[k] = target.get(k, 0) + v

    async def delete_one(self, query: dict[str, Any]) -> None:
        target = await self.find_one(query)
        if target and target in self.items:
            self.items.remove(target)

    async def delete_many(self, query: dict[str, Any]) -> None:
        to_remove = [item for item in self.items if all(item.get(k) == v for k, v in query.items())]
        for item in to_remove:
            self.items.remove(item)


class MockAuditDatabase:
    def __init__(self) -> None:
        self.users = MockCollection()
        self.sessions = MockCollection()
        self.revoked_refresh_tokens = MockCollection()
        self.conversations = MockCollection()
        self.conversation_memberships = MockCollection()
        self.messages = MockCollection()
        self.email_otps = MockCollection()
        self.password_resets = MockCollection()
        self.security_events = MockCollection()


class MockWebSocketClient:
    def __init__(self, incoming: list[Any], origin: str = "http://localhost:3000") -> None:
        self.incoming = list(incoming)
        self.sent: list[Any] = []
        self.closed_code: int | None = None
        self.headers = {"origin": origin}
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
            import json
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
# 1. AUTHENTICATION & SESSION SECURITY AUDIT
# ==============================================================================

def test_refresh_token_rotation_and_single_use() -> None:
    db = MockAuditDatabase()
    user_id = str(ObjectId())
    db.users.items.append({"_id": ObjectId(user_id), "email": "user@example.com", "username": "testuser"})

    # Issue initial tokens
    tokens = asyncio.run(issue_tokens(user_id, db))
    first_refresh = tokens.refresh_token

    # Use refresh token once -> succeeds and returns new tokens
    req = make_request("/auth/refresh")
    new_tokens = asyncio.run(refresh(req, RefreshRequest(refresh_token=first_refresh), db))
    assert new_tokens.access_token != tokens.access_token
    assert new_tokens.refresh_token != first_refresh

    # Presenting the old (rotated) refresh token again must be rejected (401)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(refresh(req, RefreshRequest(refresh_token=first_refresh), db))
    assert exc.value.status_code == 401
    assert "revoked" in exc.value.detail.lower()


def test_refresh_token_reuse_purges_all_user_sessions() -> None:
    db = MockAuditDatabase()
    user_id = str(ObjectId())
    db.users.items.append({"_id": ObjectId(user_id), "email": "user@example.com", "username": "testuser"})

    # Session 1 (Desktop)
    tokens1 = asyncio.run(issue_tokens(user_id, db))
    # Session 2 (Mobile)
    tokens2 = asyncio.run(issue_tokens(user_id, db))
    assert len(db.sessions.items) == 2

    # User refreshes Session 1 cleanly
    req = make_request("/auth/refresh")
    new_tokens1 = asyncio.run(refresh(req, RefreshRequest(refresh_token=tokens1.refresh_token), db))
    assert len(db.sessions.items) == 2

    # Attacker tries to reuse the old Session 1 refresh token
    with pytest.raises(HTTPException) as exc:
        asyncio.run(refresh(req, RefreshRequest(refresh_token=tokens1.refresh_token), db))
    assert exc.value.status_code == 401

    # Security check: ALL active sessions for that user must be purged
    assert len(db.sessions.items) == 0


def test_logout_immediately_revokes_refresh_token() -> None:
    db = MockAuditDatabase()
    user_id = str(ObjectId())

    tokens = asyncio.run(issue_tokens(user_id, db))
    assert len(db.sessions.items) == 1

    # Call logout
    req = make_request("/auth/logout")
    logout_res = asyncio.run(logout(req, RefreshRequest(refresh_token=tokens.refresh_token), db))
    assert logout_res["status"] == "logged_out"
    assert len(db.sessions.items) == 0

    # Attempting to refresh with logged-out token fails
    req_refresh = make_request("/auth/refresh")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(refresh(req_refresh, RefreshRequest(refresh_token=tokens.refresh_token), db))
    assert exc.value.status_code == 401


def test_password_reset_revokes_all_active_user_sessions() -> None:
    db = MockAuditDatabase()
    user_oid = ObjectId()
    db.users.items.append({
        "_id": user_oid,
        "email": "user@example.com",
        "password_hash": hash_password("old_password_123"),
    })

    # User has 2 active sessions
    asyncio.run(issue_tokens(str(user_oid), db))
    asyncio.run(issue_tokens(str(user_oid), db))
    assert len(db.sessions.items) == 2

    # Generate password reset token
    reset_secret = "a" * 48
    now = datetime.now(timezone.utc)
    db.password_resets.items.append({
        "user_id": user_oid,
        "token_hash": hash_otp(reset_secret),
        "created_at": now,
        "expires_at": now + timedelta(minutes=15),
    })

    # Reset password
    req = make_request("/auth/reset-password")
    res = asyncio.run(
        reset_password(
            req,
            PasswordResetRequest(token=reset_secret, password="new_password_456"),
            db,
        )
    )
    assert res["status"] == "password_reset"

    # All active sessions must be terminated
    assert len(db.sessions.items) == 0


def test_otp_brute_force_lockout_after_5_attempts() -> None:
    db = MockAuditDatabase()
    user_oid = ObjectId()
    user = UserReply(id=str(user_oid), email="target@example.com", username="target", created_at=datetime.now(timezone.utc), email_verified=False)
    now = datetime.now(timezone.utc)

    db.email_otps.items.append({
        "_id": ObjectId(),
        "user_id": user_oid,
        "purpose": "email_verification",
        "code_hash": hash_otp("123456"),
        "attempts": 0,
        "created_at": now,
        "expires_at": now + timedelta(minutes=10),
    })

    req = make_request("/auth/verify-email")

    # 4 failed attempts increment attempts counter
    for _ in range(4):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(verify_email(req, VerifyEmailRequest(code="000000"), user=user, database=db))
        assert exc.value.status_code == 400

    assert db.email_otps.items[0]["attempts"] == 4

    # 5th failed attempt increments attempts to 5
    with pytest.raises(HTTPException) as exc:
        asyncio.run(verify_email(req, VerifyEmailRequest(code="000000"), user=user, database=db))
    assert exc.value.status_code == 400
    assert db.email_otps.items[0]["attempts"] == 5

    # 6th attempt: Even if the code is now CORRECT, it must be rejected because attempts >= 5
    with pytest.raises(HTTPException) as exc:
        asyncio.run(verify_email(req, VerifyEmailRequest(code="123456"), user=user, database=db))
    assert exc.value.status_code == 400
    assert "invalid or expired" in exc.value.detail.lower()


# ==============================================================================
# 2. AUTHORIZATION & DATA ISOLATION AUDIT (IDOR & PRIVACY)
# ==============================================================================

def test_idor_cannot_access_unauthorized_conversation_by_id() -> None:
    db = MockAuditDatabase()
    alice = make_user("alice")
    mallory = make_user("mallory")
    db.users.items.extend([
        {"_id": ObjectId(alice.id), "username": "alice"},
        {"_id": ObjectId(mallory.id), "username": "mallory"},
    ])

    conv = asyncio.run(
        create_conversation(ConversationCreateRequest(kind="group", title="Alice Private"), user=alice, database=db)
    )

    # Mallory attempts IDOR access to get_conversation
    with pytest.raises(HTTPException) as exc:
        asyncio.run(get_conversation(raw_id=conv.id, user=mallory, database=db))
    assert exc.value.status_code == 404

    # Mallory attempts IDOR access to list_messages
    with pytest.raises(HTTPException) as exc:
        asyncio.run(list_messages(conversation_id=conv.id, user=mallory, database=db))
    assert exc.value.status_code == 404

    # Mallory attempts IDOR to post message
    with pytest.raises(HTTPException) as exc:
        asyncio.run(create_message(MessageCreateRequest(content="Attack"), conversation_id=conv.id, user=mallory, database=db))
    assert exc.value.status_code == 404

    # Mallory attempts IDOR to list_members
    with pytest.raises(HTTPException) as exc:
        asyncio.run(list_members(raw_id=conv.id, user=mallory, database=db))
    assert exc.value.status_code == 404


def test_user_search_privacy_zero_leakage() -> None:
    db = MockAuditDatabase()
    caller = make_user("caller")
    db.users.items.append({
        "_id": ObjectId(),
        "username": "secret_agent",
        "username_lower": "secret_agent",
        "email": "confidential@classified.gov",
        "password_hash": "$argon2id$v=19$m=65536,t=3,p=4$SECRET_HASH",
        "registration_ip": "198.51.100.42",
        "otp_code": "987654",
    })

    req = make_request("/users/search")
    results = asyncio.run(search_users(req, q="secret", user=caller, database=db))

    assert len(results) == 1
    serialized = results[0].model_dump()
    # Strictly id and username ONLY
    assert set(serialized.keys()) == {"id", "username"}
    assert "email" not in serialized
    assert "password_hash" not in serialized
    assert "registration_ip" not in serialized


def test_conversation_list_data_isolation() -> None:
    db = MockAuditDatabase()
    alice = make_user("alice")
    bob = make_user("bob")
    db.users.items.extend([
        {"_id": ObjectId(alice.id), "username": "alice"},
        {"_id": ObjectId(bob.id), "username": "bob"},
    ])

    conv_alice = asyncio.run(create_conversation(ConversationCreateRequest(kind="group", title="Alice Chat"), user=alice, database=db))
    conv_bob = asyncio.run(create_conversation(ConversationCreateRequest(kind="group", title="Bob Chat"), user=bob, database=db))

    alice_list = asyncio.run(list_conversations(user=alice, database=db))
    bob_list = asyncio.run(list_conversations(user=bob, database=db))

    assert [c.id for c in alice_list] == [conv_alice.id]
    assert [c.id for c in bob_list] == [conv_bob.id]


# ==============================================================================
# 3. ABUSE & FAILURE HANDLING AUDIT
# ==============================================================================

def test_blank_or_whitespace_message_rejected() -> None:
    with pytest.raises(ValidationError):
        MessageCreateRequest(content="")

    with pytest.raises(ValidationError):
        MessageCreateRequest(content="   ")

    with pytest.raises(ValidationError):
        MessageCreateRequest(content="\n\t   \n")


def test_oversized_message_rejected() -> None:
    with pytest.raises(ValidationError):
        MessageCreateRequest(content="A" * 4001)

    # 4000 characters is allowed
    valid = MessageCreateRequest(content="A" * 4000)
    assert len(valid.content) == 4000


def test_request_body_size_limit_middleware() -> None:
    middleware = RequestSizeLimitMiddleware(app)
    # Exceeding max request body bytes (1MB)
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/conversations",
        "headers": [(b"content-length", b"1048577")],
    }
    req = Request(scope)

    async def dummy_next(_: Request) -> Any:
        return None

    response = asyncio.run(middleware.dispatch(req, dummy_next))
    assert response.status_code == 413


def test_websocket_oversized_frame_closes_with_1009(monkeypatch: pytest.MonkeyPatch) -> None:
    db = MockAuditDatabase()
    user = make_user("ws_user")
    db.users.items.append({"_id": ObjectId(user.id), "username": "ws_user"})
    monkeypatch.setattr("app.routes.websocket.get_database", lambda: db)

    token = create_access_token(user.id)
    oversized_text = "X" * (MAX_EVENT_BYTES + 10)

    ws = MockWebSocketClient(
        incoming=[
            {"type": "auth", "access_token": token},
            oversized_text,
        ]
    )
    asyncio.run(websocket_endpoint(ws))
    assert ws.closed_code == 1009


def test_websocket_malformed_event_closes_with_1008(monkeypatch: pytest.MonkeyPatch) -> None:
    db = MockAuditDatabase()
    user = make_user("ws_user")
    db.users.items.append({"_id": ObjectId(user.id), "username": "ws_user"})
    monkeypatch.setattr("app.routes.websocket.get_database", lambda: db)

    token = create_access_token(user.id)

    # Non-subscribe event
    ws = MockWebSocketClient(
        incoming=[
            {"type": "auth", "access_token": token},
            {"type": "unsupported_action"},
        ]
    )
    asyncio.run(websocket_endpoint(ws))
    assert ws.closed_code == 1008


def test_websocket_queue_cleaned_up_on_disconnect(monkeypatch: pytest.MonkeyPatch) -> None:
    db = MockAuditDatabase()
    user = make_user("ws_user")
    db.users.items.append({"_id": ObjectId(user.id), "username": "ws_user"})
    monkeypatch.setattr("app.routes.websocket.get_database", lambda: db)

    token = create_access_token(user.id)
    user_oid = ObjectId(user.id)

    ws = MockWebSocketClient(
        incoming=[
            {"type": "auth", "access_token": token},
        ]
    )
    asyncio.run(websocket_endpoint(ws))

    # Connection closed cleanly; queue must be discarded from connections
    assert user_oid not in connections or len(connections[user_oid]) == 0
