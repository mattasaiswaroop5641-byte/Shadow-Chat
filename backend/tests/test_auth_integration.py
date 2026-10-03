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

from app.core.security import hash_password, token_hash
from app.routes.auth import (
    LoginRequest,
    RefreshRequest,
    RegisterRequest,
    UserReply,
    VerifyEmailRequest,
    hash_otp,
    issue_tokens,
    login,
    logout,
    refresh,
    register,
    verified_user,
    verify_email,
)


class MockCollection:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    async def insert_one(self, doc: dict[str, Any]) -> SimpleNamespace:
        doc = dict(doc)
        if '_id' not in doc:
            doc['_id'] = ObjectId()
        self.docs.append(doc)
        return SimpleNamespace(inserted_id=doc['_id'])

    async def find_one(self, query: dict[str, Any], sort: Any = None) -> dict[str, Any] | None:
        for doc in reversed(self.docs) if sort else self.docs:
            match = True
            for k, v in query.items():
                if k == "$or":
                    sub_matches = [
                        all(doc.get(sub_k) == sub_v for sub_k, sub_v in sub_q.items())
                        for sub_q in v
                    ]
                    if not any(sub_matches):
                        match = False
                        break
                elif doc.get(k) != v:
                    match = False
                    break
            if match:
                return dict(doc)
        return None

    async def find_one_and_delete(self, query: dict[str, Any]) -> dict[str, Any] | None:
        for i, doc in enumerate(self.docs):
            if all(doc.get(k) == v for k, v in query.items()):
                return dict(self.docs.pop(i))
        return None

    async def update_one(self, query: dict[str, Any], update: dict[str, Any]) -> None:
        for doc in self.docs:
            if all(doc.get(k) == v for k, v in query.items()):
                if "$set" in update:
                    doc.update(update["$set"])
                if "$inc" in update:
                    for inc_k, inc_v in update["$inc"].items():
                        doc[inc_k] = doc.get(inc_k, 0) + inc_v
                break

    async def delete_one(self, query: dict[str, Any]) -> None:
        for i, doc in enumerate(self.docs):
            if all(doc.get(k) == v for k, v in query.items()):
                self.docs.pop(i)
                break

    async def delete_many(self, query: dict[str, Any]) -> None:
        self.docs = [
            doc for doc in self.docs
            if not all(doc.get(k) == v for k, v in query.items())
        ]


class MockAuthDatabase:
    def __init__(self) -> None:
        self.users = MockCollection()
        self.email_otps = MockCollection()
        self.sessions = MockCollection()
        self.revoked_refresh_tokens = MockCollection()
        self.security_events = MockCollection()
        self.password_resets = MockCollection()


def make_request(client_ip: str = "127.0.0.1", path: str = "/") -> Request:
    return Request({
        "type": "http",
        "method": "POST",
        "path": path,
        "client": (client_ip, 12345),
        "headers": [],
    })


def test_register_creates_account_and_dispatches_otp_mocked(monkeypatch: pytest.MonkeyPatch) -> None:
    db = MockAuthDatabase()
    sent_emails: list[dict[str, str]] = []

    async def fake_send_email(recipient: str, subject: str, html: str) -> None:
        sent_emails.append({'to': recipient, 'subject': subject, 'html': html})

    monkeypatch.setattr('app.routes.auth.send_transactional_email', fake_send_email)

    payload = RegisterRequest(email='alice@example.com', username='alice_01', password='ValidPassword123!')
    tokens = asyncio.run(register(payload, make_request(), db))

    assert tokens.access_token
    assert tokens.refresh_token
    assert len(db.users.docs) == 1
    assert db.users.docs[0]['email'] == 'alice@example.com'
    assert db.users.docs[0]['email_verified'] is False
    assert len(sent_emails) == 1
    assert len(db.email_otps.docs) == 1


def test_register_validates_username_format() -> None:
    with pytest.raises(ValidationError):
        RegisterRequest(email='bob@example.com', username='bad username!', password='Password123!')


def test_register_rejects_duplicate_email() -> None:
    db = MockAuthDatabase()
    db.users.docs.append({
        '_id': ObjectId(),
        'email': 'existing@example.com',
        'username_lower': 'existing',
    })

    payload = RegisterRequest(email='existing@example.com', username='newuser', password='Password123!')
    with pytest.raises(HTTPException) as exc:
        asyncio.run(register(payload, make_request(), db))
    assert exc.value.status_code == 409


def test_verify_email_success() -> None:
    db = MockAuthDatabase()
    user_id = ObjectId()
    db.users.docs.append({
        '_id': user_id,
        'email': 'carol@example.com',
        'username': 'carol',
        'created_at': datetime.now(timezone.utc),
        'email_verified': False,
    })
    db.email_otps.docs.append({
        '_id': ObjectId(),
        'user_id': user_id,
        'purpose': 'email_verification',
        'code_hash': hash_otp('654321'),
        'attempts': 0,
        'expires_at': datetime.now(timezone.utc) + timedelta(minutes=10),
    })

    user = UserReply(
        id=str(user_id),
        email='carol@example.com',
        username='carol',
        created_at=datetime.now(timezone.utc),
        email_verified=False,
    )

    result = asyncio.run(verify_email(make_request(), VerifyEmailRequest(code='654321'), user, db))
    assert result == {'status': 'email_verified'}
    assert db.users.docs[0]['email_verified'] is True
    assert len(db.email_otps.docs) == 0


def test_verify_email_rejects_wrong_code_and_increments_attempts() -> None:
    db = MockAuthDatabase()
    user_id = ObjectId()
    db.users.docs.append({'_id': user_id, 'email_verified': False})
    db.email_otps.docs.append({
        '_id': ObjectId(),
        'user_id': user_id,
        'purpose': 'email_verification',
        'code_hash': hash_otp('654321'),
        'attempts': 0,
        'expires_at': datetime.now(timezone.utc) + timedelta(minutes=10),
    })

    user = UserReply(
        id=str(user_id),
        email='carol@example.com',
        username='carol',
        created_at=datetime.now(timezone.utc),
        email_verified=False,
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(verify_email(make_request(), VerifyEmailRequest(code='000000'), user, db))
    assert exc.value.status_code == 400
    assert db.email_otps.docs[0]['attempts'] == 1


def test_login_success_and_invalid_credentials() -> None:
    db = MockAuthDatabase()
    user_id = ObjectId()
    db.users.docs.append({
        '_id': user_id,
        'email': 'dave@example.com',
        'username': 'dave',
        'password_hash': hash_password('CorrectSecret123!'),
        'created_at': datetime.now(timezone.utc),
        'email_verified': True,
    })

    tokens = asyncio.run(login(make_request(), LoginRequest(email='dave@example.com', password='CorrectSecret123!'), db))
    assert tokens.access_token
    assert tokens.refresh_token

    with pytest.raises(HTTPException) as exc:
        asyncio.run(login(make_request(), LoginRequest(email='dave@example.com', password='WrongPassword123!'), db))
    assert exc.value.status_code == 401

    with pytest.raises(HTTPException) as exc:
        asyncio.run(login(make_request(), LoginRequest(email='nobody@example.com', password='CorrectSecret123!'), db))
    assert exc.value.status_code == 401


def test_refresh_token_rotation_and_reuse_detection() -> None:
    db = MockAuthDatabase()
    user_id = ObjectId()
    db.users.docs.append({
        '_id': user_id,
        'email': 'eve@example.com',
        'username': 'eve',
        'created_at': datetime.now(timezone.utc),
        'email_verified': True,
    })

    initial_tokens = asyncio.run(issue_tokens(str(user_id), db))
    assert len(db.sessions.docs) == 1

    new_tokens = asyncio.run(refresh(make_request(), RefreshRequest(refresh_token=initial_tokens.refresh_token), db))
    assert new_tokens.access_token != initial_tokens.access_token
    assert len(db.sessions.docs) == 1
    assert len(db.revoked_refresh_tokens.docs) == 1

    with pytest.raises(HTTPException) as exc:
        asyncio.run(refresh(make_request(), RefreshRequest(refresh_token=initial_tokens.refresh_token), db))
    assert exc.value.status_code == 401
    assert len(db.sessions.docs) == 0


def test_logout_clears_session() -> None:
    db = MockAuthDatabase()
    user_id = ObjectId()
    tokens = asyncio.run(issue_tokens(str(user_id), db))
    assert len(db.sessions.docs) == 1

    result = asyncio.run(logout(make_request(), RefreshRequest(refresh_token=tokens.refresh_token), db))
    assert result == {'status': 'logged_out'}
    assert len(db.sessions.docs) == 0


def test_verified_user_guard() -> None:
    unverified = UserReply(
        id=str(ObjectId()),
        email='unverified@example.com',
        username='unverified',
        created_at=datetime.now(timezone.utc),
        email_verified=False,
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(verified_user(unverified))
    assert exc.value.status_code == 403

    verified = UserReply(
        id=str(ObjectId()),
        email='verified@example.com',
        username='verified',
        created_at=datetime.now(timezone.utc),
        email_verified=True,
    )
    result = asyncio.run(verified_user(verified))
    assert result.email_verified is True


def test_oauth_providers_endpoint() -> None:
    from app.routes.auth import get_oauth_providers
    res = asyncio.run(get_oauth_providers())
    assert "providers" in res
    assert "google" in res["providers"]
    assert "github" in res["providers"]
    assert "microsoft" in res["providers"]


def test_dev_oauth_login() -> None:
    from app.routes.auth import DevOAuthLoginRequest, dev_oauth_login
    db = MockAuthDatabase()
    req = make_request()
    
    # Test dev login for Google
    tokens = asyncio.run(
        dev_oauth_login(
            DevOAuthLoginRequest(provider="google", email="test.google@shadowchat.net", username="google_dev_user"),
            req,
            db,
        )
    )
    assert tokens.access_token is not None
    assert tokens.refresh_token is not None
    
    # Verify user created in DB is marked verified
    user = asyncio.run(db.users.find_one({"email": "test.google@shadowchat.net"}))
    assert user is not None
    assert user["email_verified"] is True
    assert user["oauth_provider"] == "google"

