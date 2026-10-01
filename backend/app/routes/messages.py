from datetime import datetime, timezone
import os
from pathlib import Path as PathLib
from typing import Any
from uuid import uuid4

from bson import ObjectId
from fastapi import APIRouter, Depends, File, HTTPException, Path, Query, UploadFile, status
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field, field_validator

from app.core.config import get_uploads_dir
from app.core.database import get_database
from app.routes.auth import UserReply, verified_user
from app.routes.conversations import get_member_conversation
from app.routes.websocket import is_user_online, publish

router = APIRouter(prefix="/conversations/{conversation_id}/messages", tags=["messages"])


class Attachment(BaseModel):
    id: str
    filename: str
    content_type: str
    size_bytes: int
    url: str
    is_encrypted: bool = False


class ReplySummary(BaseModel):
    id: str
    sender_id: str
    sender_username: str | None = None
    content: str
    is_encrypted: bool = False


class MessageCreateRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=4000)
    nonce: str | None = Field(default=None, max_length=128)
    is_encrypted: bool = False
    reply_to_id: str | None = None
    attachments: list[Attachment] = Field(default_factory=list)

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Message content cannot be blank")
        return value


class MessageUpdateRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=4000)
    nonce: str | None = Field(default=None, max_length=128)
    is_encrypted: bool = False

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Message content cannot be blank")
        return value


class MessageReactionRequest(BaseModel):
    emoji: str = Field(..., min_length=1, max_length=16)


class MessageReply(BaseModel):
    id: str
    conversation_id: str
    sender_id: str
    content: str
    client_id: str
    nonce: str | None = None
    is_encrypted: bool = False
    status: str = "sent"
    created_at: datetime
    edited_at: datetime | None = None
    is_edited: bool = False
    is_deleted: bool = False
    reply_to_id: str | None = None
    reply_to: ReplySummary | None = None
    attachments: list[Attachment] = Field(default_factory=list)
    reactions: dict[str, list[str]] = Field(default_factory=dict)


def serialize_message(document: dict[str, Any]) -> MessageReply:
    status_val = document.get("status")
    if not status_val:
        if document.get("read_by"):
            status_val = "read"
        elif document.get("delivered_to"):
            status_val = "delivered"
        else:
            status_val = "sent"

    raw_attachments = document.get("attachments") or []
    attachments = [
        Attachment(**a) if isinstance(a, dict) else a
        for a in raw_attachments
    ]

    reply_to_data = document.get("reply_to")
    reply_to = ReplySummary(**reply_to_data) if isinstance(reply_to_data, dict) else None

    return MessageReply(
        id=str(document["_id"]),
        conversation_id=str(document["conversation_id"]),
        sender_id=str(document["sender_id"]),
        content=document["content"],
        client_id=document.get("client_id", ""),
        nonce=document.get("nonce"),
        is_encrypted=document.get("is_encrypted", False),
        status=status_val,
        created_at=document["created_at"],
        edited_at=document.get("edited_at"),
        is_edited=document.get("is_edited", False),
        is_deleted=document.get("is_deleted", False),
        reply_to_id=document.get("reply_to_id"),
        reply_to=reply_to,
        attachments=attachments,
        reactions=document.get("reactions") or {},
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
    memberships = await database.conversation_memberships.find(
        {"conversation_id": conversation["_id"]}, {"user_id": 1}
    ).to_list(length=1000)

    other_user_ids = [m["user_id"] for m in memberships if m["user_id"] != ObjectId(user.id)]
    online_others = [uid for uid in other_user_ids if is_user_online(uid)]
    initial_status = "delivered" if online_others else "sent"

    reply_to_doc = None
    if payload.reply_to_id and ObjectId.is_valid(payload.reply_to_id):
        target_msg = await database.messages.find_one({
            "_id": ObjectId(payload.reply_to_id),
            "conversation_id": conversation["_id"],
        })
        if target_msg:
            target_user = await database.users.find_one({"_id": target_msg["sender_id"]})
            reply_to_doc = {
                "id": str(target_msg["_id"]),
                "sender_id": str(target_msg["sender_id"]),
                "sender_username": target_user.get("username", "Member") if target_user else "Member",
                "content": target_msg.get("content", ""),
                "is_encrypted": target_msg.get("is_encrypted", False),
            }

    raw_attachments = [a.model_dump() for a in payload.attachments]

    document = {
        "conversation_id": conversation["_id"],
        "sender_id": ObjectId(user.id),
        "content": payload.content,
        "nonce": payload.nonce,
        "is_encrypted": payload.is_encrypted,
        "client_id": str(uuid4()),
        "status": initial_status,
        "delivered_to": online_others,
        "read_by": [],
        "reply_to_id": payload.reply_to_id,
        "reply_to": reply_to_doc,
        "attachments": raw_attachments,
        "reactions": {},
        "is_edited": False,
        "is_deleted": False,
        "created_at": now,
    }
    await database.messages.insert_one(document)
    await database.conversations.update_one(
        {"_id": conversation["_id"]}, {"$set": {"updated_at": now}}
    )
    await publish(
        [membership["user_id"] for membership in memberships],
        {"type": "message", "message": serialize_message(document).model_dump(mode="json")},
    )
    return serialize_message(document)


@router.post("/read", status_code=status.HTTP_200_OK)
async def mark_messages_read(
    conversation_id: str = Path(..., min_length=1, max_length=24),
    user: UserReply = Depends(verified_user),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> dict[str, Any]:
    conversation = await get_member_conversation(conversation_id, user, database)
    caller_oid = ObjectId(user.id)
    result = await database.messages.update_many(
        {
            "conversation_id": conversation["_id"],
            "sender_id": {"$ne": caller_oid},
            "read_by": {"$ne": caller_oid},
        },
        {
            "$addToSet": {"read_by": caller_oid},
            "$set": {"status": "read"},
        },
    )
    memberships = await database.conversation_memberships.find(
        {"conversation_id": conversation["_id"]}, {"user_id": 1}
    ).to_list(length=1000)
    target_ids = [m["user_id"] for m in memberships if m["user_id"] != caller_oid]
    if target_ids:
        await publish(
            target_ids,
            {
                "type": "read_receipt",
                "conversation_id": str(conversation["_id"]),
                "reader_id": user.id,
            },
        )
    return {"status": "ok", "modified_count": result.modified_count}


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


@router.post("/attachments", response_model=Attachment, status_code=status.HTTP_201_CREATED)
async def upload_attachment(
    conversation_id: str = Path(..., min_length=1, max_length=24),
    file: UploadFile = File(...),
    user: UserReply = Depends(verified_user),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> Attachment:
    await get_member_conversation(conversation_id, user, database)
    content = await file.read()
    if len(content) > 15 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 15MB)")

    uploads_dir = get_uploads_dir()

    ext = PathLib(file.filename or "file").suffix
    safe_name = f"{uuid4().hex}{ext}"
    file_path = uploads_dir / safe_name
    file_path.write_bytes(content)

    return Attachment(
        id=uuid4().hex[:12],
        filename=file.filename or "attachment",
        content_type=file.content_type or "application/octet-stream",
        size_bytes=len(content),
        url=f"/attachments/{safe_name}",
    )


@router.post("/{message_id}/reactions", response_model=dict[str, list[str]])
async def toggle_reaction(
    payload: MessageReactionRequest,
    conversation_id: str = Path(..., min_length=1, max_length=24),
    message_id: str = Path(..., min_length=1, max_length=24),
    user: UserReply = Depends(verified_user),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> dict[str, list[str]]:
    conversation = await get_member_conversation(conversation_id, user, database)
    if not ObjectId.is_valid(message_id):
        raise HTTPException(status_code=404, detail="Message not found")
    message = await database.messages.find_one({
        "_id": ObjectId(message_id),
        "conversation_id": conversation["_id"],
    })
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")

    reactions = dict(message.get("reactions") or {})
    emoji = payload.emoji.strip()
    user_ids = list(reactions.get(emoji) or [])
    if user.id in user_ids:
        user_ids.remove(user.id)
    else:
        user_ids.append(user.id)

    if user_ids:
        reactions[emoji] = user_ids
    else:
        reactions.pop(emoji, None)

    await database.messages.update_one(
        {"_id": message["_id"]},
        {"$set": {"reactions": reactions}},
    )

    memberships = await database.conversation_memberships.find(
        {"conversation_id": conversation["_id"]}, {"user_id": 1}
    ).to_list(length=1000)
    await publish(
        [m["user_id"] for m in memberships],
        {
            "type": "message_reaction",
            "conversation_id": conversation_id,
            "message_id": message_id,
            "reactions": reactions,
        },
    )
    return reactions


@router.put("/{message_id}", response_model=MessageReply)
async def edit_message(
    payload: MessageUpdateRequest,
    conversation_id: str = Path(..., min_length=1, max_length=24),
    message_id: str = Path(..., min_length=1, max_length=24),
    user: UserReply = Depends(verified_user),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> MessageReply:
    conversation = await get_member_conversation(conversation_id, user, database)
    if not ObjectId.is_valid(message_id):
        raise HTTPException(status_code=404, detail="Message not found")
    message = await database.messages.find_one({
        "_id": ObjectId(message_id),
        "conversation_id": conversation["_id"],
    })
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    if message["sender_id"] != ObjectId(user.id):
        raise HTTPException(status_code=403, detail="Cannot edit another user's message")
    if message.get("is_deleted"):
        raise HTTPException(status_code=400, detail="Cannot edit a deleted message")

    now = datetime.now(timezone.utc)
    await database.messages.update_one(
        {"_id": message["_id"]},
        {
            "$set": {
                "content": payload.content,
                "nonce": payload.nonce,
                "is_encrypted": payload.is_encrypted,
                "is_edited": True,
                "edited_at": now,
            }
        },
    )
    updated_message = await database.messages.find_one({"_id": message["_id"]})
    reply = serialize_message(updated_message)

    memberships = await database.conversation_memberships.find(
        {"conversation_id": conversation["_id"]}, {"user_id": 1}
    ).to_list(length=1000)
    await publish(
        [m["user_id"] for m in memberships],
        {
            "type": "message_edited",
            "message": reply.model_dump(mode="json"),
        },
    )
    return reply


@router.delete("/{message_id}", status_code=status.HTTP_200_OK)
async def delete_message(
    conversation_id: str = Path(..., min_length=1, max_length=24),
    message_id: str = Path(..., min_length=1, max_length=24),
    user: UserReply = Depends(verified_user),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> dict[str, Any]:
    conversation = await get_member_conversation(conversation_id, user, database)
    if not ObjectId.is_valid(message_id):
        raise HTTPException(status_code=404, detail="Message not found")
    message = await database.messages.find_one({
        "_id": ObjectId(message_id),
        "conversation_id": conversation["_id"],
    })
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")

    is_sender = message["sender_id"] == ObjectId(user.id)
    is_owner = conversation.get("owner_id") == ObjectId(user.id)
    if not (is_sender or is_owner):
        raise HTTPException(status_code=403, detail="Cannot delete this message")

    now = datetime.now(timezone.utc)
    await database.messages.update_one(
        {"_id": message["_id"]},
        {
            "$set": {
                "is_deleted": True,
                "content": "[This message was deleted]",
                "nonce": None,
                "is_encrypted": False,
                "attachments": [],
                "reactions": {},
                "deleted_at": now,
            }
        },
    )

    memberships = await database.conversation_memberships.find(
        {"conversation_id": conversation["_id"]}, {"user_id": 1}
    ).to_list(length=1000)
    await publish(
        [m["user_id"] for m in memberships],
        {
            "type": "message_deleted",
            "conversation_id": conversation_id,
            "message_id": message_id,
        },
    )
    return {"status": "ok", "message_id": message_id}
