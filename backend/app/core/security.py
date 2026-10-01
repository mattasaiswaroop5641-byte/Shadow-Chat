from datetime import datetime, timedelta, timezone
from hashlib import sha256
from typing import Any
from uuid import uuid4

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.core.config import get_settings

ph = PasswordHasher()
settings = get_settings()


def hash_password(password: str) -> str:
    return ph.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return ph.verify(password_hash, password)
    except (InvalidHashError, VerificationError, VerifyMismatchError):
        return False


def create_access_token(subject: str, extra_claims: dict[str, Any] | None = None) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": subject,
        "exp": now + timedelta(minutes=settings.access_token_expire_minutes),
        "iat": now,
        "type": "access",
        "jti": str(uuid4()),
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
    }
    if extra_claims:
        payload.update({key: value for key, value in extra_claims.items() if key not in payload})
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def create_refresh_token(subject: str, jti: str, extra_claims: dict[str, Any] | None = None) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": subject,
        "jti": jti,
        "exp": now + timedelta(days=settings.refresh_token_expire_days),
        "iat": now,
        "type": "refresh",
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
    }
    if extra_claims:
        payload.update({key: value for key, value in extra_claims.items() if key not in payload})
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def decode_token(token: str) -> dict[str, Any]:
    return jwt.decode(
        token,
        settings.secret_key,
        algorithms=[settings.algorithm],
        issuer=settings.jwt_issuer,
        audience=settings.jwt_audience,
        options={"require": ["exp", "iat", "sub", "type", "iss", "aud"]},
    )


def token_hash(token: str) -> str:
    return sha256(token.encode("utf-8")).hexdigest()
