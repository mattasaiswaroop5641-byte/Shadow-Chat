from datetime import datetime, timezone
import re
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, status
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core.database import get_database
from app.routes.auth import UserReply, verified_user

router = APIRouter(prefix="/users", tags=["users"])
limiter = Limiter(key_func=get_remote_address)


class UserSummary(BaseModel):
    id: str
    username: str


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
    users = await cursor.to_list(length=10)
    return [
        UserSummary(
            id=str(doc["_id"]),
            username=doc["username"],
        )
        for doc in users
    ]


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

