from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field, field_validator

from app.core.database import get_database
from app.routes.auth import UserReply, verified_user
from app.routes.conversations import get_member_conversation
from app.routes.websocket import publish

router = APIRouter(prefix="/conversations/{conversation_id}/messages", tags=["messages"])


class MessageCreateRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=4000)

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Message content cannot be blank")
        return value


class MessageReply(BaseModel):
    id: str
    conversation_id: str
    sender_id: str
    content: str
    client_id: str
    created_at: datetime


def serialize_message(document: dict[str, Any]) -> MessageReply:
    return MessageReply(
        id=str(document["_id"]),
        conversation_id=str(document["conversation_id"]),
        sender_id=str(document["sender_id"]),
        content=document["content"],
        client_id=document["client_id"],
        created_at=document["created_at"],
    )


@router.post("", response_model=MessageReply, status_code=status.HTTP_201_CREATED)
async def create_message(
    payload: MessageCreateRequest,
    conversation_id: str = Path(..., min_length=1, max_length=24),
    user: UserReply = Depends(verified_user),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> MessageReply:
    conversation = await get_member_conversation(conversation_id, user, database)
    now = datetime.now(timezone.utc)
    document = {
        "conversation_id": conversation["_id"],
        "sender_id": ObjectId(user.id),
        "content": payload.content,
        "client_id": str(uuid4()),
        "created_at": now,
    }
    await database.messages.insert_one(document)
    await database.conversations.update_one(
        {"_id": conversation["_id"]}, {"$set": {"updated_at": now}}
    )
    memberships = await database.conversation_memberships.find(
        {"conversation_id": conversation["_id"]}, {"user_id": 1}
    ).to_list(length=1000)
    await publish(
        [membership["user_id"] for membership in memberships],
        {"type": "message", "message": serialize_message(document).model_dump(mode="json")},
    )
    return serialize_message(document)


@router.get("", response_model=list[MessageReply])
async def list_messages(
    conversation_id: str = Path(..., min_length=1, max_length=24),
    before: datetime | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    user: UserReply = Depends(verified_user),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> list[MessageReply]:
    conversation = await get_member_conversation(conversation_id, user, database)
    query: dict[str, Any] = {"conversation_id": conversation["_id"]}
    if isinstance(before, datetime):
        query["created_at"] = {"$lt": before}
    limit_val = int(limit.default if hasattr(limit, "default") else limit)
    documents = await database.messages.find(query).sort("created_at", -1).limit(limit_val).to_list(limit_val)
    return [serialize_message(document) for document in reversed(documents)]
