import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))

from app.core.config import Settings, get_settings
from app.core.security import create_access_token, decode_token, hash_password, verify_password
from app.routes.websocket import is_allowed_origin


def test_password_hash_is_argon2_and_verifies() -> None:
    password_hash = hash_password("correct horse battery staple")
    assert password_hash.startswith("$argon2")
    assert verify_password("correct horse battery staple", password_hash)
    assert not verify_password("wrong password", password_hash)


def test_access_token_requires_expected_issuer_and_audience() -> None:
    token = create_access_token("507f1f77bcf86cd799439011")
    claims = decode_token(token)
    settings = get_settings()
    assert claims["type"] == "access"
    assert claims["iss"] == settings.jwt_issuer
    assert claims["aud"] == settings.jwt_audience
    assert claims["jti"]


def test_decode_rejects_wrong_issuer() -> None:
    token = create_access_token("507f1f77bcf86cd799439011")
    with pytest.raises(jwt.InvalidIssuerError):
        jwt.decode(
            token,
            get_settings().secret_key,
            algorithms=[get_settings().algorithm],
            issuer="wrong-issuer",
            audience=get_settings().jwt_audience,
        )


def test_decode_rejects_expired_token() -> None:
    token = jwt.encode(
        {
            "sub": "507f1f77bcf86cd799439011",
            "exp": datetime.now(timezone.utc) - timedelta(minutes=1),
            "iat": datetime.now(timezone.utc) - timedelta(minutes=2),
            "type": "access",
            "iss": get_settings().jwt_issuer,
            "aud": get_settings().jwt_audience,
        },
        get_settings().secret_key,
        algorithm=get_settings().algorithm,
    )

    with pytest.raises(jwt.ExpiredSignatureError):
        decode_token(token)


def test_websocket_rejects_unconfigured_origin() -> None:
    assert not is_allowed_origin("https://untrusted.example")
    assert is_allowed_origin(None)


def test_settings_reject_unsafe_production_configuration() -> None:
    settings = Settings()
    settings.app_env = "production"
    settings.secret_key = "short"
    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        settings.validate()
