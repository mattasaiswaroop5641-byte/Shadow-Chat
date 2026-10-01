import re
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, Depends, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core.database import get_database
from app.routes.auth import UserReply, verified_user

router = APIRouter(prefix="/users", tags=["users"])
limiter = Limiter(key_func=get_remote_address)


class UserSummary(BaseModel):
    id: str
    username: str


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
    return [UserSummary(id=str(doc["_id"]), username=doc["username"]) for doc in users]
