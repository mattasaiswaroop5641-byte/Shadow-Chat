from datetime import datetime, timedelta, timezone
import hashlib
import logging
import secrets
from typing import Any
from uuid import uuid4

import jwt
from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, EmailStr, Field, field_validator
from pymongo.errors import DuplicateKeyError
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core.config import get_settings
from app.core.database import get_database
from app.core.audit import record_security_event
from app.core.mail import MailDeliveryError, send_transactional_email
from app.core.oauth import (
    build_authorization_url,
    decode_state,
    encode_state,
    exchange_oauth_code,
    is_provider_configured,
)
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    token_hash,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])
bearer_scheme = HTTPBearer(auto_error=False)
settings = get_settings()
limiter = Limiter(key_func=get_remote_address)
logger = logging.getLogger(__name__)


class RegisterRequest(BaseModel):
    email: EmailStr
    username: str = Field(..., min_length=3, max_length=32)
    password: str = Field(..., min_length=8, max_length=128)

    @field_validator("username")
    @classmethod
    def validate_username(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized.replace("_", "").isalnum():
            raise ValueError("Username may contain only letters, numbers, and underscores")
        return normalized


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8, max_length=128)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(..., min_length=1)


class VerifyEmailRequest(BaseModel):
    code: str = Field(..., min_length=6, max_length=6, pattern=r"^\d{6}$")


class EmailRequest(BaseModel):
    email: EmailStr


class PasswordResetRequest(BaseModel):
    token: str = Field(..., min_length=32, max_length=256)
    password: str = Field(..., min_length=8, max_length=128)


class TokenReply(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class UserReply(BaseModel):
    id: str
    email: EmailStr
    username: str
    created_at: datetime
    email_verified: bool
    avatar_url: str | None = None
    status_message: str | None = None


def serialize_user(user: dict[str, Any]) -> UserReply:
    return UserReply(
        id=str(user["_id"]),
        email=user["email"],
        username=user["username"],
        created_at=user["created_at"],
        email_verified=user.get("email_verified", False),
        avatar_url=user.get("avatar_url"),
        status_message=user.get("status_message"),
    )


def hash_otp(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def is_expired(value: datetime) -> bool:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value <= datetime.now(timezone.utc)


async def create_email_otp(user: UserReply, database: AsyncIOMotorDatabase) -> None:
    now = datetime.now(timezone.utc)
    await database.email_otps.delete_many(
        {"user_id": ObjectId(user.id), "purpose": "email_verification"}
    )
    code = f"{secrets.randbelow(1_000_000):06d}"
    await database.email_otps.insert_one(
        {
            "user_id": ObjectId(user.id),
            "purpose": "email_verification",
            "code_hash": hash_otp(code),
            "attempts": 0,
            "created_at": now,
            "expires_at": now + timedelta(minutes=10),
        }
    )
    try:
        await send_transactional_email(
            user.email,
            "Verify your Shadow Chat email",
            f"<p>Your Shadow Chat verification code is <strong>{code}</strong>.</p>"
            "<p>This code expires in 10 minutes and can be used once.</p>",
        )
    except MailDeliveryError:
        await database.email_otps.delete_many(
            {"user_id": ObjectId(user.id), "purpose": "email_verification"}
        )
        raise


async def send_password_reset(user: dict[str, Any], database: AsyncIOMotorDatabase) -> None:
    now = datetime.now(timezone.utc)
    reset_token = secrets.token_urlsafe(48)
    await database.password_resets.delete_many({"user_id": user["_id"]})
    await database.password_resets.insert_one(
        {
            "user_id": user["_id"],
            "token_hash": hash_otp(reset_token),
            "created_at": now,
            "expires_at": now + timedelta(minutes=15),
        }
    )
    try:
        await send_transactional_email(
            user["email"],
            "Reset your Shadow Chat password",
            "<p>Use the password reset token in the Shadow Chat app.</p>"
            f"<p><strong>{reset_token}</strong></p>"
            "<p>This token expires in 15 minutes and can be used once.</p>",
        )
    except MailDeliveryError:
        await database.password_resets.delete_many({"user_id": user["_id"]})
        raise


async def issue_tokens(user_id: str, database: AsyncIOMotorDatabase) -> TokenReply:
    session_id = str(uuid4())
    refresh_token = create_refresh_token(user_id, session_id)
    expires_at = datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_expire_days)
    await database.sessions.insert_one(
        {
            "session_id": session_id,
            "user_id": ObjectId(user_id),
            "token_hash": token_hash(refresh_token),
            "created_at": datetime.now(timezone.utc),
            "expires_at": expires_at,
        }
    )
    return TokenReply(access_token=create_access_token(user_id), refresh_token=refresh_token)


async def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> UserReply:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    try:
        payload = decode_token(credentials.credentials)
        if payload.get("type") != "access" or not ObjectId.is_valid(payload.get("sub", "")):
            raise ValueError("Invalid access token")
    except (jwt.InvalidTokenError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid access token") from exc

    user = await database.users.find_one({"_id": ObjectId(payload["sub"])})
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid access token")
    return serialize_user(user)


async def verified_user(
    user: UserReply = Depends(current_user),
) -> UserReply:
    if not user.email_verified:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Email verification required",
        )
    return user


@router.post("/register", response_model=TokenReply, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
async def register(payload: RegisterRequest, request: Request, database: AsyncIOMotorDatabase = Depends(get_database)) -> TokenReply:
    email = str(payload.email).lower()
    username_lower = payload.username.lower()
    if await database.users.find_one({"$or": [{"email": email}, {"username_lower": username_lower}]}):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email or username already in use")

    user = {
        "email": email,
        "username": payload.username,
        "username_lower": username_lower,
        "password_hash": hash_password(payload.password),
        "created_at": datetime.now(timezone.utc),
        "email_verified": False,
        "registration_ip": request.client.host if request.client else None,
    }
    try:
        result = await database.users.insert_one(user)
    except DuplicateKeyError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email or username already in use") from exc
    created_user = await database.users.find_one({"_id": result.inserted_id})
    if created_user is None:
        raise HTTPException(status_code=500, detail="Unable to create account")
    user_reply = serialize_user(created_user)
    try:
        await create_email_otp(user_reply, database)
    except MailDeliveryError as exc:
        await database.users.delete_one({"_id": result.inserted_id})
        raise HTTPException(status_code=503, detail="Email verification is temporarily unavailable") from exc
    return await issue_tokens(str(result.inserted_id), database)


@router.post("/login", response_model=TokenReply)
@limiter.limit("10/minute")
async def login(
    request: Request,
    payload: LoginRequest,
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> TokenReply:
    user = await database.users.find_one({"email": str(payload.email).lower()})
    if user is None or not verify_password(payload.password, user["password_hash"]):
        await record_security_event(database, event_type="auth.login_failed")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    return await issue_tokens(str(user["_id"]), database)


@router.post("/refresh", response_model=TokenReply)
@limiter.limit("20/minute")
async def refresh(
    request: Request,
    payload: RefreshRequest,
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> TokenReply:
    try:
        claims = decode_token(payload.refresh_token)
        if claims.get("type") != "refresh" or not claims.get("jti") or not ObjectId.is_valid(claims.get("sub", "")):
            raise ValueError("Invalid refresh token")
    except (jwt.InvalidTokenError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token") from exc

    refresh_hash = token_hash(payload.refresh_token)
    session = await database.sessions.find_one_and_delete(
        {"session_id": claims["jti"], "token_hash": refresh_hash}
    )
    if session is None:
        revoked = await database.revoked_refresh_tokens.find_one({"token_hash": refresh_hash})
        if revoked is not None:
            await database.sessions.delete_many({"user_id": revoked["user_id"]})
            logger.warning("Refresh token reuse detected; revoked user sessions")
            await record_security_event(
                database,
                event_type="auth.refresh_reuse_detected",
                user_id=revoked["user_id"],
            )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token revoked")

    await database.revoked_refresh_tokens.insert_one(
        {
            "token_hash": refresh_hash,
            "session_id": claims["jti"],
            "user_id": session["user_id"],
            "expires_at": session["expires_at"],
        }
    )
    user = await database.users.find_one({"_id": ObjectId(claims["sub"])})
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token revoked")
    return await issue_tokens(str(user["_id"]), database)


@router.post("/logout")
@limiter.limit("30/minute")
async def logout(
    request: Request,
    payload: RefreshRequest,
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> dict[str, str]:
    await database.sessions.delete_one({"token_hash": token_hash(payload.refresh_token)})
    return {"status": "logged_out"}


@router.get("/me", response_model=UserReply)
async def me(user: UserReply = Depends(verified_user)) -> UserReply:
    return user


@router.post("/verify-email")
@limiter.limit("10/minute")
async def verify_email(
    request: Request,
    payload: VerifyEmailRequest,
    user: UserReply = Depends(current_user),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> dict[str, str]:
    record = await database.email_otps.find_one(
        {"user_id": ObjectId(user.id), "purpose": "email_verification"}
    )
    if record is None or record["attempts"] >= 5:
        raise HTTPException(status_code=400, detail="Invalid or expired verification code")
    if is_expired(record["expires_at"]):
        raise HTTPException(status_code=400, detail="Invalid or expired verification code")
    if record["code_hash"] != hash_otp(payload.code):
        await database.email_otps.update_one(
            {"_id": record["_id"]}, {"$inc": {"attempts": 1}}
        )
        raise HTTPException(status_code=400, detail="Invalid or expired verification code")
    await database.email_otps.delete_one({"_id": record["_id"]})
    await database.users.update_one(
        {"_id": ObjectId(user.id)}, {"$set": {"email_verified": True}}
    )
    return {"status": "email_verified"}


@router.post("/resend-verification")
@limiter.limit("3/hour")
async def resend_verification(
    request: Request,
    database: AsyncIOMotorDatabase = Depends(get_database),
    user: UserReply = Depends(current_user),
) -> dict[str, str]:
    account = await database.users.find_one({"_id": ObjectId(user.id)})
    if account is None or account.get("email_verified", False):
        return {"status": "verification_email_requested"}
    latest = await database.email_otps.find_one(
        {"user_id": ObjectId(user.id), "purpose": "email_verification"},
        sort=[("created_at", -1)],
    )
    if latest:
        created_at = latest["created_at"]
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        if created_at > datetime.now(timezone.utc) - timedelta(seconds=60):
            raise HTTPException(status_code=429, detail="Please wait before requesting another code")
    try:
        await create_email_otp(user, database)
    except MailDeliveryError as exc:
        raise HTTPException(status_code=503, detail="Email verification is temporarily unavailable") from exc
    return {"status": "verification_email_requested"}


@router.post("/forgot-password")
@limiter.limit("5/hour")
async def forgot_password(
    request: Request,
    payload: EmailRequest,
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> dict[str, str]:
    user = await database.users.find_one({"email": str(payload.email).lower()})
    if user is not None:
        try:
            await send_password_reset(user, database)
        except MailDeliveryError:
            logger.exception("Password reset email delivery failed")
    return {"status": "password_reset_requested"}


@router.post("/reset-password")
@limiter.limit("5/hour")
async def reset_password(
    request: Request,
    payload: PasswordResetRequest,
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> dict[str, str]:
    reset = await database.password_resets.find_one_and_delete(
        {"token_hash": hash_otp(payload.token)}
    )
    if reset is None or is_expired(reset["expires_at"]):
        raise HTTPException(status_code=400, detail="Invalid or expired password reset token")
    await database.users.update_one(
        {"_id": reset["user_id"]},
        {"$set": {"password_hash": hash_password(payload.password)}},
    )
    await database.sessions.delete_many({"user_id": reset["user_id"]})
    return {"status": "password_reset"}


def sanitize_username(raw: str) -> str:
    cleaned = "".join(c if c.isalnum() or c == "_" else "_" for c in raw.strip().lower())
    cleaned = "_".join(filter(None, cleaned.split("_")))
    if len(cleaned) < 3:
        cleaned = f"{cleaned}_operative"
    return cleaned[:28]


@router.get("/oauth/providers")
async def get_oauth_providers() -> dict[str, Any]:
    return {
        "providers": {
            "google": is_provider_configured("google"),
            "github": is_provider_configured("github"),
            "microsoft": is_provider_configured("microsoft"),
        }
    }


@router.get("/{provider}/login")
async def oauth_login(
    provider: str,
    request: Request,
    return_to: str | None = None,
) -> RedirectResponse:
    prov = provider.lower()
    if prov not in {"google", "github", "microsoft"}:
        raise HTTPException(status_code=400, detail=f"Unsupported OAuth provider: {provider}")

    target_return = return_to or settings.frontend_url
    if not is_provider_configured(prov):
        if settings.app_env == "development":
            return RedirectResponse(
                url=f"{target_return.rstrip('/')}/?oauth_config_needed={prov}",
                status_code=status.HTTP_307_TEMPORARY_REDIRECT,
            )
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=f"{prov.capitalize()} OAuth is not configured on this server.",
        )

    base_url = settings.backend_public_url or str(request.base_url).rstrip("/")
    redirect_uri = f"{base_url.rstrip('/')}/auth/{prov}/callback"
    state = encode_state({
        "return_to": target_return,
        "nonce": secrets.token_hex(16),
        "provider": prov,
    })
    auth_url = build_authorization_url(prov, redirect_uri, state)
    return RedirectResponse(url=auth_url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)


@router.get("/{provider}/callback")
async def oauth_callback(
    provider: str,
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> RedirectResponse:
    prov = provider.lower()
    if prov not in {"google", "github", "microsoft"}:
        raise HTTPException(status_code=400, detail="Invalid provider")

    state_data = decode_state(state) if state else {}
    return_to = state_data.get("return_to") or settings.frontend_url

    if error:
        err_msg = error_description or error or "Authentication canceled or denied"
        return RedirectResponse(
            url=f"{return_to.rstrip('/')}/?auth_error={err_msg}",
            status_code=status.HTTP_307_TEMPORARY_REDIRECT,
        )

    if not code:
        return RedirectResponse(
            url=f"{return_to.rstrip('/')}/?auth_error=No+authorization+code+received",
            status_code=status.HTTP_307_TEMPORARY_REDIRECT,
        )

    base_url = settings.backend_public_url or str(request.base_url).rstrip("/")
    redirect_uri = f"{base_url.rstrip('/')}/auth/{prov}/callback"

    try:
        user_info = await exchange_oauth_code(prov, code, redirect_uri)
    except Exception as exc:
        logger.exception("OAuth exchange failed for %s", prov)
        return RedirectResponse(
            url=f"{return_to.rstrip('/')}/?auth_error={str(exc)}",
            status_code=status.HTTP_307_TEMPORARY_REDIRECT,
        )

    email = user_info.email.lower()
    existing_user = await database.users.find_one({"email": email})

    if existing_user is not None:
        user_id = str(existing_user["_id"])
        update_fields: dict[str, Any] = {"email_verified": True}
        if not existing_user.get("avatar_url") and user_info.avatar_url:
            update_fields["avatar_url"] = user_info.avatar_url
        await database.users.update_one({"_id": existing_user["_id"]}, {"$set": update_fields})
    else:
        raw_name = user_info.username or user_info.name or email.split("@")[0]
        base_user = sanitize_username(raw_name)
        username = base_user
        counter = 1
        while await database.users.find_one({"username_lower": username.lower()}):
            username = f"{base_user[:26]}_{counter}"
            counter += 1

        new_user = {
            "email": email,
            "username": username,
            "username_lower": username.lower(),
            "password_hash": hash_password(secrets.token_urlsafe(32)),
            "created_at": datetime.now(timezone.utc),
            "email_verified": True,
            "avatar_url": user_info.avatar_url,
            "oauth_provider": prov,
            "oauth_id": user_info.provider_id,
            "registration_ip": request.client.host if request.client else None,
        }
        res = await database.users.insert_one(new_user)
        user_id = str(res.inserted_id)

    tokens = await issue_tokens(user_id, database)
    return RedirectResponse(
        url=f"{return_to.rstrip('/')}/?access_token={tokens.access_token}&refresh_token={tokens.refresh_token}&provider={prov}",
        status_code=status.HTTP_307_TEMPORARY_REDIRECT,
    )


class DevOAuthLoginRequest(BaseModel):
    provider: str
    email: EmailStr | None = None
    username: str | None = None


@router.post("/oauth/dev-login", response_model=TokenReply)
async def dev_oauth_login(
    payload: DevOAuthLoginRequest,
    request: Request,
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> TokenReply:
    if settings.app_env != "development":
        raise HTTPException(status_code=403, detail="Dev login is only allowed in development")

    prov = payload.provider.lower()
    if prov not in {"google", "github", "microsoft"}:
        raise HTTPException(status_code=400, detail="Invalid provider")

    email = str(payload.email or f"{prov}_operative@shadowchat.net").lower()
    existing_user = await database.users.find_one({"email": email})

    if existing_user is not None:
        user_id = str(existing_user["_id"])
        await database.users.update_one({"_id": existing_user["_id"]}, {"$set": {"email_verified": True}})
    else:
        desired_username = payload.username or f"agent_{prov}"
        base_user = sanitize_username(desired_username)
        username = base_user
        counter = 1
        while await database.users.find_one({"username_lower": username.lower()}):
            username = f"{base_user[:26]}_{counter}"
            counter += 1

        new_user = {
            "email": email,
            "username": username,
            "username_lower": username.lower(),
            "password_hash": hash_password(secrets.token_urlsafe(32)),
            "created_at": datetime.now(timezone.utc),
            "email_verified": True,
            "avatar_url": None,
            "oauth_provider": prov,
            "oauth_id": f"dev_{prov}_{secrets.token_hex(4)}",
            "registration_ip": request.client.host if request.client else None,
        }
        res = await database.users.insert_one(new_user)
        user_id = str(res.inserted_id)

    return await issue_tokens(user_id, database)

