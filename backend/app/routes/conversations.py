from datetime import datetime, timezone
from typing import Any, Literal

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Path, status
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field, field_validator
from pymongo.errors import DuplicateKeyError

from app.core.database import get_database
from app.routes.auth import UserReply, verified_user
from app.routes.websocket import is_user_online, publish

router = APIRouter(prefix="/conversations", tags=["conversations"])


class ConversationCreateRequest(BaseModel):
    kind: Literal["direct", "group"]
    recipient_id: str | None = None
    participant_ids: list[str] = Field(default_factory=list)
    title: str | None = Field(default=None, max_length=100)
    invite_policy: Literal["all_members", "owner_only"] = "all_members"

    @field_validator("title")
    @classmethod
    def sanitize_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class ConversationReply(BaseModel):
    id: str
    kind: Literal["direct", "group"]
    owner_id: str
    title: str | None = None
    recipient_id: str | None = None
    recipient_username: str | None = None
    recipient_avatar_url: str | None = None
    recipient_status_message: str | None = None
    invite_policy: Literal["all_members", "owner_only"] = "all_members"
    created_at: datetime
    updated_at: datetime


class AddMemberRequest(BaseModel):
    user_id: str | None = None
    username: str | None = None


class MemberReply(BaseModel):
    id: str
    conversation_id: str
    user_id: str
    username: str
    role: Literal["owner", "member"]
    created_at: datetime
    public_key: str | None = None
    is_online: bool = False
    avatar_url: str | None = None
    status_message: str | None = None


def serialize_conversation(
    document: dict[str, Any],
    recipient_info: dict[str, Any] | None = None,
) -> ConversationReply:
    rec_info = recipient_info or document.get("recipient_info") or {}
    title = document.get("title")
    if document.get("kind") == "direct" and not title and rec_info.get("recipient_username"):
        title = f"@{rec_info['recipient_username']}"

    return ConversationReply(
        id=str(document["_id"]),
        kind=document["kind"],
        owner_id=str(document["owner_id"]),
        title=title,
        recipient_id=rec_info.get("recipient_id"),
        recipient_username=rec_info.get("recipient_username"),
        recipient_avatar_url=rec_info.get("recipient_avatar_url"),
        recipient_status_message=rec_info.get("recipient_status_message"),
        invite_policy=document.get("invite_policy", "all_members"),
        created_at=document["created_at"],
        updated_at=document["updated_at"],
    )


def conversation_id(value: str) -> ObjectId:
    if not ObjectId.is_valid(value):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return ObjectId(value)


async def get_member_conversation(
    raw_id: str,
    user: UserReply,
    database: AsyncIOMotorDatabase,
) -> dict[str, Any]:
    object_id = conversation_id(raw_id)
    membership = await database.conversation_memberships.find_one(
        {"conversation_id": object_id, "user_id": ObjectId(user.id)}
    )
    if membership is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    conversation = await database.conversations.find_one({"_id": object_id})
    if conversation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return conversation


@router.post("", response_model=ConversationReply, status_code=status.HTTP_201_CREATED)
async def create_conversation(
    payload: ConversationCreateRequest,
    user: UserReply = Depends(verified_user),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> ConversationReply:
    now = datetime.now(timezone.utc)
    members_to_add: list[ObjectId] = []
    recipient_info: dict[str, Any] | None = None

    if payload.kind == "direct":
        recipient_id = payload.recipient_id
        if not recipient_id and len(payload.participant_ids) == 1:
            recipient_id = payload.participant_ids[0]
        if not recipient_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Direct conversation requires a recipient",
            )
        if not ObjectId.is_valid(recipient_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid recipient ID",
            )
        if recipient_id == user.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot create a direct conversation with yourself",
            )
        recipient = None
        if hasattr(database, "users"):
            recipient = await database.users.find_one({"_id": ObjectId(recipient_id)})
            if recipient is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Recipient not found",
                )
            recipient_info = {
                "recipient_id": str(recipient["_id"]),
                "recipient_username": recipient.get("username"),
                "recipient_avatar_url": recipient.get("avatar_url"),
                "recipient_status_message": recipient.get("status_message"),
            }

        if hasattr(database, "conversation_memberships") and hasattr(database.conversation_memberships, "find"):
            try:
                user_cursor = database.conversation_memberships.find(
                    {"user_id": ObjectId(user.id)}, {"conversation_id": 1}
                )
                user_memberships = await user_cursor.to_list(length=1000) if hasattr(user_cursor, "to_list") else await user_cursor
                conv_ids = [m["conversation_id"] for m in user_memberships]
                if conv_ids:
                    direct_cursor = database.conversations.find(
                        {"_id": {"$in": conv_ids}, "kind": "direct"}
                    )
                    direct_convs = await direct_cursor.to_list(length=1000) if hasattr(direct_cursor, "to_list") else await direct_cursor
                    direct_ids = [c["_id"] for c in direct_convs]
                    if direct_ids:
                        existing_m = await database.conversation_memberships.find_one(
                            {"conversation_id": {"$in": direct_ids}, "user_id": ObjectId(recipient_id)}
                        )
                        if existing_m is not None:
                            existing_conv = await database.conversations.find_one({"_id": existing_m["conversation_id"]})
                            if existing_conv is not None:
                                return serialize_conversation(existing_conv, recipient_info=recipient_info)
            except Exception:
                pass
        members_to_add.append(ObjectId(recipient_id))

    elif payload.kind == "group":
        if len(payload.participant_ids) > 50:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Group conversation cannot exceed 50 initial participants",
            )
        for pid in payload.participant_ids:
            if not ObjectId.is_valid(pid):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid participant ID: {pid}",
                )
        unique_pids = list(dict.fromkeys(pid for pid in payload.participant_ids if pid != user.id))
        if unique_pids and hasattr(database, "users"):
            users_cursor = database.users.find(
                {"_id": {"$in": [ObjectId(pid) for pid in unique_pids]}},
                {"_id": 1},
            )
            found_users = await users_cursor.to_list(length=len(unique_pids)) if hasattr(users_cursor, "to_list") else await users_cursor
            found_ids = {str(u["_id"]) for u in found_users}
            missing = [pid for pid in unique_pids if pid not in found_ids]
            if missing:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"One or more participants not found: {', '.join(missing)}",
                )
        for pid in unique_pids:
            members_to_add.append(ObjectId(pid))

    conversation = {
        "owner_id": ObjectId(user.id),
        "kind": payload.kind,
        "title": payload.title,
        "invite_policy": payload.invite_policy,
        "created_at": now,
        "updated_at": now,
    }
    result = await database.conversations.insert_one(conversation)
    conversation_id_value = result.inserted_id

    try:
        await database.conversation_memberships.insert_one(
            {
                "conversation_id": conversation_id_value,
                "user_id": ObjectId(user.id),
                "role": "owner",
                "created_at": now,
            }
        )
        for member_oid in members_to_add:
            await database.conversation_memberships.insert_one(
                {
                    "conversation_id": conversation_id_value,
                    "user_id": member_oid,
                    "role": "member",
                    "created_at": now,
                }
            )
    except DuplicateKeyError:
        await database.conversations.delete_one({"_id": conversation_id_value})
        await database.conversation_memberships.delete_many({"conversation_id": conversation_id_value})
        raise HTTPException(status_code=409, detail="Conversation could not be created")
    except Exception:
        await database.conversations.delete_one({"_id": conversation_id_value})
        await database.conversation_memberships.delete_many({"conversation_id": conversation_id_value})
        raise

    conversation["_id"] = conversation_id_value
    return serialize_conversation(conversation, recipient_info=recipient_info)


@router.get("", response_model=list[ConversationReply])
async def list_conversations(
    user: UserReply = Depends(verified_user),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> list[ConversationReply]:
    cursor = database.conversation_memberships.find(
        {"user_id": ObjectId(user.id)},
        {"conversation_id": 1},
    ).sort("created_at", -1)
    memberships = await cursor.to_list(length=100) if hasattr(cursor, "to_list") else await cursor
    ids = [membership["conversation_id"] for membership in memberships]
    if not ids:
        return []
    conv_cursor = database.conversations.find({"_id": {"$in": ids}})
    conversations = await conv_cursor.to_list(length=100) if hasattr(conv_cursor, "to_list") else await conv_cursor
    by_id = {document["_id"]: document for document in conversations}

    direct_conv_ids = [doc["_id"] for doc in conversations if doc.get("kind") == "direct"]
    direct_partners: dict[Any, dict[str, Any]] = {}
    if direct_conv_ids and hasattr(database, "conversation_memberships") and hasattr(database.conversation_memberships, "find"):
        try:
            other_m_cursor = database.conversation_memberships.find({
                "conversation_id": {"$in": direct_conv_ids},
                "user_id": {"$ne": ObjectId(user.id)},
            })
            other_memberships = await other_m_cursor.to_list(length=len(direct_conv_ids) * 2) if hasattr(other_m_cursor, "to_list") else await other_m_cursor
            partner_user_ids = [m["user_id"] for m in other_memberships]
            if partner_user_ids and hasattr(database, "users") and hasattr(database.users, "find"):
                u_cursor = database.users.find(
                    {"_id": {"$in": partner_user_ids}},
                    {"_id": 1, "username": 1, "avatar_url": 1, "status_message": 1},
                )
                partner_users = await u_cursor.to_list(length=len(partner_user_ids)) if hasattr(u_cursor, "to_list") else await u_cursor
                users_map = {u["_id"]: u for u in partner_users}
                for m in other_memberships:
                    u = users_map.get(m["user_id"])
                    if u:
                        direct_partners[m["conversation_id"]] = {
                            "recipient_id": str(u["_id"]),
                            "recipient_username": u.get("username"),
                            "recipient_avatar_url": u.get("avatar_url"),
                            "recipient_status_message": u.get("status_message"),
                        }
        except Exception:
            pass

    return [
        serialize_conversation(by_id[item], recipient_info=direct_partners.get(item))
        for item in ids
        if item in by_id
    ]


@router.get("/{raw_id}", response_model=ConversationReply)
async def get_conversation(
    raw_id: str = Path(..., min_length=1, max_length=24),
    user: UserReply = Depends(verified_user),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> ConversationReply:
    conversation = await get_member_conversation(raw_id, user, database)
    recipient_info = None
    if conversation.get("kind") == "direct" and hasattr(database, "conversation_memberships"):
        try:
            other_m = await database.conversation_memberships.find_one({
                "conversation_id": conversation["_id"],
                "user_id": {"$ne": ObjectId(user.id)},
            })
            if other_m and hasattr(database, "users"):
                u = await database.users.find_one({"_id": other_m["user_id"]})
                if u:
                    recipient_info = {
                        "recipient_id": str(u["_id"]),
                        "recipient_username": u.get("username"),
                        "recipient_avatar_url": u.get("avatar_url"),
                        "recipient_status_message": u.get("status_message"),
                    }
        except Exception:
            pass
    return serialize_conversation(conversation, recipient_info=recipient_info)


@router.post("/{raw_id}/members", response_model=MemberReply, status_code=status.HTTP_201_CREATED)
async def add_member(
    payload: AddMemberRequest,
    raw_id: str = Path(..., min_length=1, max_length=24),
    user: UserReply = Depends(verified_user),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> MemberReply:
    conversation = await get_member_conversation(raw_id, user, database)
    if conversation.get("kind") != "group":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot add members to a direct conversation",
        )
    if conversation.get("invite_policy") == "owner_only":
        caller_membership = await database.conversation_memberships.find_one(
            {"conversation_id": conversation["_id"], "user_id": ObjectId(user.id)}
        )
        if caller_membership is None or caller_membership.get("role") != "owner":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only the conversation owner may invite members",
            )
    if not payload.user_id and not payload.username:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Either user_id or username must be provided",
        )

    target_user = None
    if payload.user_id:
        if not ObjectId.is_valid(payload.user_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid user ID",
            )
        target_user = await database.users.find_one({"_id": ObjectId(payload.user_id)})
    elif payload.username:
        target_user = await database.users.find_one(
            {"username_lower": payload.username.strip().lower()}
        )

    if target_user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    target_user_id = target_user["_id"]
    existing_membership = await database.conversation_memberships.find_one(
        {"conversation_id": conversation["_id"], "user_id": target_user_id}
    )
    if existing_membership is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="User is already a member of this conversation",
        )

    now = datetime.now(timezone.utc)
    membership_doc = {
        "conversation_id": conversation["_id"],
        "user_id": target_user_id,
        "role": "member",
        "created_at": now,
    }
    try:
        result = await database.conversation_memberships.insert_one(membership_doc)
        inserted_id = result.inserted_id
    except DuplicateKeyError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="User is already a member of this conversation",
        )

    # Publish notification to all conversation members (including the new member)
    try:
        cursor = database.conversation_memberships.find(
            {"conversation_id": conversation["_id"]}, {"user_id": 1}
        )
        memberships = await cursor.to_list(length=1000) if hasattr(cursor, "to_list") else await cursor
        await publish(
            [m["user_id"] for m in memberships],
            {
                "type": "member_joined",
                "conversation_id": str(conversation["_id"]),
                "user": {
                    "id": str(target_user["_id"]),
                    "username": target_user["username"],
                },
            },
        )
    except Exception:
        pass

    return MemberReply(
        id=str(inserted_id),
        conversation_id=str(conversation["_id"]),
        user_id=str(target_user["_id"]),
        username=target_user["username"],
        role="member",
        created_at=now,
    )


@router.get("/{raw_id}/members", response_model=list[MemberReply])
async def list_members(
    raw_id: str = Path(..., min_length=1, max_length=24),
    user: UserReply = Depends(verified_user),
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> list[MemberReply]:
    conversation = await get_member_conversation(raw_id, user, database)
    cursor = database.conversation_memberships.find(
        {"conversation_id": conversation["_id"]}
    ).sort("created_at", 1)
    memberships = await cursor.to_list(length=1000) if hasattr(cursor, "to_list") else await cursor
    user_ids = [m["user_id"] for m in memberships]
    users_cursor = database.users.find(
        {"_id": {"$in": user_ids}},
        {"_id": 1, "username": 1, "public_key": 1, "avatar_url": 1, "status_message": 1},
    )
    users = await users_cursor.to_list(length=len(user_ids)) if hasattr(users_cursor, "to_list") else await users_cursor
    users_by_id: dict[Any, Any] = {}
    for u in users:
        uid = u["_id"] if isinstance(u, dict) else getattr(u, "_id", None)
        users_by_id[uid] = u

    return [
        MemberReply(
            id=str(m["_id"]),
            conversation_id=str(m["conversation_id"]),
            user_id=str(m["user_id"]),
            username=(
                users_by_id.get(m["user_id"], {}).get("username", "Unknown")
                if isinstance(users_by_id.get(m["user_id"]), dict)
                else getattr(users_by_id.get(m["user_id"]), "username", "Unknown")
            ),
            role=m.get("role", "member"),
            created_at=m["created_at"],
            public_key=(
                users_by_id.get(m["user_id"], {}).get("public_key")
                if isinstance(users_by_id.get(m["user_id"]), dict)
                else getattr(users_by_id.get(m["user_id"]), "public_key", None)
            ),
            is_online=is_user_online(m["user_id"]),
            avatar_url=(
                users_by_id.get(m["user_id"], {}).get("avatar_url")
                if isinstance(users_by_id.get(m["user_id"]), dict)
                else getattr(users_by_id.get(m["user_id"]), "avatar_url", None)
            ),
            status_message=(
                users_by_id.get(m["user_id"], {}).get("status_message")
                if isinstance(users_by_id.get(m["user_id"]), dict)
                else getattr(users_by_id.get(m["user_id"]), "status_message", None)
            ),
        )
        for m in memberships
    ]
