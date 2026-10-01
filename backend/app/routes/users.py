from datetime import datetime, timezone
from pathlib import Path as PathLib
import re
from typing import Any
from uuid import uuid4

from bson import ObjectId
from fastapi import APIRouter, Depends, File, HTTPException, Path, Query, Request, UploadFile, status
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core.config import get_uploads_dir
from app.core.database import get_database
from app.routes.auth import UserReply, serialize_user, verified_user
from app.routes.websocket import is_user_online, publish

router = APIRouter(prefix="/users", tags=["users"])
limiter = Limiter(key_func=get_remote_address)


class UserSummary(BaseModel):
    id: str
    username: str


class ProfileUpdateRequest(BaseModel):
    avatar_url: str | None = Field(default=None, max_length=2048)
    status_message: str | None = Field(default=None, max_length=140)


class PublicKeyUpdateRequest(BaseModel):
    public_key: str = Field(..., min_length=10, max_length=1024)


class PublicKeyResponse(BaseModel):
    user_id: str
    public_key: str | None = None


@router.get("/search", response_model=list[UserSummary])
@limiter.limit("30/minute")
async def search_users(
    request: Request,
    q: str = Query(..., min_length=1, max_length=50),
    user: UserReply = Depends(verified_user),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> list[UserSummary]:
    normalized = q.strip().lower()
    if not normalized:
        return []
    escaped = re.escape(normalized)
    query: dict[str, Any] = {
        "username_lower": {"$regex": f"^{escaped}"},
    }
    if ObjectId.is_valid(user.id):
        query["_id"] = {"$ne": ObjectId(user.id)}
    cursor = database.users.find(query, {"_id": 1, "username": 1})
    if hasattr(cursor, "limit"):
        cursor = cursor.limit(10)
    users = await cursor.to_list(length=10) if hasattr(cursor, "to_list") else await cursor
    return [
        UserSummary(
            id=str(doc["_id"]),
            username=doc["username"],
        )
        for doc in users
    ]


@router.get("/presence", response_model=dict[str, bool])
async def get_users_presence(
    user_ids: str = Query(..., min_length=1, max_length=1000),
    user: UserReply = Depends(verified_user),
) -> dict[str, bool]:
    ids = [uid.strip() for uid in user_ids.split(",") if ObjectId.is_valid(uid.strip())]
    return {uid: is_user_online(ObjectId(uid)) for uid in ids}


@router.put("/me/public-key", status_code=status.HTTP_204_NO_CONTENT)
async def update_public_key(
    payload: PublicKeyUpdateRequest,
    user: UserReply = Depends(verified_user),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> None:
    cleaned_key = payload.public_key.strip()
    if not ObjectId.is_valid(user.id):
        raise HTTPException(status_code=400, detail="Invalid user ID")
    now = datetime.now(timezone.utc)
    await database.users.update_one(
        {"_id": ObjectId(user.id)},
        {"$set": {"public_key": cleaned_key, "public_key_updated_at": now}},
    )


@router.get("/{user_id}/public-key", response_model=PublicKeyResponse)
async def get_user_public_key(
    user_id: str = Path(..., min_length=1, max_length=24),
    user: UserReply = Depends(verified_user),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> PublicKeyResponse:
    if not ObjectId.is_valid(user_id):
        raise HTTPException(status_code=404, detail="User not found")
    target_user = await database.users.find_one({"_id": ObjectId(user_id)}, {"public_key": 1})
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")
    return PublicKeyResponse(user_id=user_id, public_key=target_user.get("public_key"))


@router.put("/me/profile", response_model=UserReply)
async def update_user_profile(
    payload: ProfileUpdateRequest,
    user: UserReply = Depends(verified_user),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> UserReply:
    if not ObjectId.is_valid(user.id):
        raise HTTPException(status_code=400, detail="Invalid user ID")

    update_fields: dict[str, Any] = {
        "avatar_url": payload.avatar_url.strip() if payload.avatar_url else None,
        "status_message": payload.status_message.strip() if payload.status_message else None,
    }
    await database.users.update_one(
        {"_id": ObjectId(user.id)},
        {"$set": update_fields},
    )
    updated = await database.users.find_one({"_id": ObjectId(user.id)})
    if not updated:
        raise HTTPException(status_code=404, detail="User not found")

    reply = serialize_user(updated)
    try:
        if hasattr(database, "conversation_memberships") and hasattr(database.conversation_memberships, "find"):
            m_cursor = database.conversation_memberships.find(
                {"user_id": ObjectId(user.id)}, {"conversation_id": 1}
            )
            memberships = await m_cursor.to_list(length=100) if hasattr(m_cursor, "to_list") else await m_cursor
            conv_ids = [m["conversation_id"] for m in memberships]
            if conv_ids:
                peer_cursor = database.conversation_memberships.find(
                    {"conversation_id": {"$in": conv_ids}}, {"user_id": 1}
                )
                peer_memberships = await peer_cursor.to_list(length=1000) if hasattr(peer_cursor, "to_list") else await peer_cursor
                peer_ids = list({m["user_id"] for m in peer_memberships})
                await publish(
                    peer_ids,
                    {
                        "type": "user_profile_updated",
                        "user_id": user.id,
                        "username": user.username,
                        "avatar_url": reply.avatar_url,
                        "status_message": reply.status_message,
                    },
                )
    except Exception:
        pass

    return reply


@router.post("/me/avatar", response_model=UserReply)
async def upload_user_avatar(
    file: UploadFile = File(...),
    user: UserReply = Depends(verified_user),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> UserReply:
    if not ObjectId.is_valid(user.id):
        raise HTTPException(status_code=400, detail="Invalid user ID")

    content = await file.read()
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Avatar image too large (max 5MB)")

    content_type = file.content_type or "image/png"
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image (PNG, JPG, WebP, etc.)")

    uploads_dir = get_uploads_dir()
    ext = PathLib(file.filename or "avatar.png").suffix or ".png"
    safe_name = f"avatar_{user.id}_{uuid4().hex[:8]}{ext}"
    file_path = uploads_dir / safe_name
    file_path.write_bytes(content)

    avatar_url = f"/attachments/{safe_name}"
    await database.users.update_one(
        {"_id": ObjectId(user.id)},
        {"$set": {"avatar_url": avatar_url}},
    )
    updated = await database.users.find_one({"_id": ObjectId(user.id)})
    if not updated:
        raise HTTPException(status_code=404, detail="User not found")

    reply = serialize_user(updated)
    try:
        if hasattr(database, "conversation_memberships") and hasattr(database.conversation_memberships, "find"):
            m_cursor = database.conversation_memberships.find(
                {"user_id": ObjectId(user.id)}, {"conversation_id": 1}
            )
            memberships = await m_cursor.to_list(length=100) if hasattr(m_cursor, "to_list") else await m_cursor
            conv_ids = [m["conversation_id"] for m in memberships]
            if conv_ids:
                peer_cursor = database.conversation_memberships.find(
                    {"conversation_id": {"$in": conv_ids}}, {"user_id": 1}
                )
                peer_memberships = await peer_cursor.to_list(length=1000) if hasattr(peer_cursor, "to_list") else await peer_cursor
                peer_ids = list({m["user_id"] for m in peer_memberships})
                await publish(
                    peer_ids,
                    {
                        "type": "user_profile_updated",
                        "user_id": user.id,
                        "username": user.username,
                        "avatar_url": reply.avatar_url,
                        "status_message": reply.status_message,
                    },
                )
    except Exception:
        pass

    return reply


