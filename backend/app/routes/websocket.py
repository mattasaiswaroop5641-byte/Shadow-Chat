import asyncio
import json
from collections import defaultdict
from collections import deque
from time import monotonic
from typing import Any

import jwt
from bson import ObjectId
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.core.config import get_settings
from app.core.database import get_database
from app.core.security import decode_token

router = APIRouter()
settings = get_settings()
MAX_QUEUE_SIZE = 100
MAX_EVENT_BYTES = 8192
CONNECTION_ATTEMPT_WINDOW_SECONDS = 60.0
MAX_CONNECTION_ATTEMPTS_PER_IP = 30
MESSAGE_WINDOW_SECONDS = 10.0
MAX_MESSAGES_PER_CONNECTION = 30
connections: dict[ObjectId, set[asyncio.Queue[str]]] = defaultdict(set)
connection_attempts: dict[str, deque[float]] = defaultdict(deque)


def is_allowed_origin(origin: str | None) -> bool:
    if origin is None:
        return True
    return origin.strip().rstrip("/") in settings.websocket_origins



def allow_connection_attempt(client_host: str | None) -> bool:
    key = client_host or "unknown"
    now = monotonic()
    attempts = connection_attempts[key]
    while attempts and now - attempts[0] > CONNECTION_ATTEMPT_WINDOW_SECONDS:
        attempts.popleft()
    if len(attempts) >= MAX_CONNECTION_ATTEMPTS_PER_IP:
        return False
    attempts.append(now)
    return True


def is_user_online(user_id: ObjectId) -> bool:
    return bool(connections.get(user_id))


def get_online_user_ids() -> set[str]:
    return {str(uid) for uid, queues in connections.items() if queues}


async def get_user_peer_ids(user_id: ObjectId, database: AsyncIOMotorDatabase) -> list[ObjectId]:
    try:
        if not hasattr(database, "conversation_memberships") or not hasattr(database.conversation_memberships, "find"):
            return []
        user_memberships = await database.conversation_memberships.find(
            {"user_id": user_id}, {"conversation_id": 1}
        ).to_list(length=1000)
        conv_ids = [m["conversation_id"] for m in user_memberships]
        if not conv_ids:
            return []
        peer_memberships = await database.conversation_memberships.find(
            {"conversation_id": {"$in": conv_ids}}, {"user_id": 1}
        ).to_list(length=5000)
        peer_ids = list({m["user_id"] for m in peer_memberships if m["user_id"] != user_id})
        return peer_ids
    except Exception:
        return []


async def authenticate(websocket: WebSocket, database: AsyncIOMotorDatabase) -> ObjectId | None:
    try:
        event = await asyncio.wait_for(websocket.receive_json(), timeout=10)
        if not isinstance(event, dict):
            return None
        token = event.get("access_token") if event.get("type") == "auth" else None
        claims = decode_token(token) if isinstance(token, str) else {}
        user_id = claims.get("sub", "")
        if claims.get("type") != "access" or not ObjectId.is_valid(user_id):
            return None
        user = await database.users.find_one({"_id": ObjectId(user_id)})
        return ObjectId(user_id) if user is not None else None
    except (asyncio.TimeoutError, ValueError, TypeError, jwt.InvalidTokenError):
        return None


async def publish(user_ids: list[ObjectId], event: dict[str, Any]) -> None:
    payload = json.dumps(event, separators=(",", ":"))
    for user_id in user_ids:
        for queue in list(connections.get(user_id, ())):
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                connections[user_id].discard(queue)


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    if not is_allowed_origin(websocket.headers.get("origin")):
        await websocket.close(code=1008)
        return
    client_host = websocket.client.host if websocket.client else None
    if not allow_connection_attempt(client_host):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    database = get_database()
    user_id = await authenticate(websocket, database)
    if user_id is None:
        await websocket.close(code=1008)
        return
    queue: asyncio.Queue[str] = asyncio.Queue(maxsize=MAX_QUEUE_SIZE)
    message_times: deque[float] = deque()
    
    is_first_connection = len(connections[user_id]) == 0
    connections[user_id].add(queue)
    if is_first_connection:
        peer_ids = await get_user_peer_ids(user_id, database)
        if peer_ids:
            await publish(peer_ids, {"type": "presence", "user_id": str(user_id), "status": "online"})

    try:
        while True:
            send_task = asyncio.create_task(queue.get())
            receive_task = asyncio.create_task(websocket.receive_text())
            done, pending = await asyncio.wait(
                {send_task, receive_task}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            completed = done.pop()
            if completed is send_task:
                await websocket.send_text(completed.result())
                continue
            raw = completed.result()
            if len(raw.encode("utf-8")) > MAX_EVENT_BYTES:
                await websocket.close(code=1009)
                return
            now = monotonic()
            while message_times and now - message_times[0] > MESSAGE_WINDOW_SECONDS:
                message_times.popleft()
            if len(message_times) >= MAX_MESSAGES_PER_CONNECTION:
                await websocket.close(code=1008)
                return
            message_times.append(now)
            event = json.loads(raw)
            if not isinstance(event, dict):
                await websocket.close(code=1008)
                return
            event_type = event.get("type")
            if event_type not in ("subscribe", "typing", "read", "delivery_ack"):
                await websocket.close(code=1008)
                return

            conv_id_raw = event.get("conversation_id")
            if not isinstance(conv_id_raw, str) or not ObjectId.is_valid(conv_id_raw):
                await websocket.close(code=1008)
                return

            membership = await database.conversation_memberships.find_one(
                {
                    "conversation_id": ObjectId(conv_id_raw),
                    "user_id": user_id,
                }
            )
            if membership is None:
                await websocket.close(code=1008)
                return

            if event_type == "subscribe":
                await websocket.send_json({"type": "subscribed", "conversation_id": conv_id_raw})
            elif event_type == "typing":
                is_typing = bool(event.get("is_typing", True))
                target_user_ids: list[ObjectId] = []
                try:
                    if hasattr(database.conversation_memberships, "find"):
                        conv_members = await database.conversation_memberships.find(
                            {"conversation_id": ObjectId(conv_id_raw)}, {"user_id": 1}
                        ).to_list(length=200)
                        target_user_ids = [m["user_id"] for m in conv_members if m["user_id"] != user_id]
                except Exception:
                    pass
                caller_user = await database.users.find_one({"_id": user_id})
                username = caller_user.get("username", "Someone") if caller_user else "Someone"
                if target_user_ids:
                    await publish(target_user_ids, {
                        "type": "typing",
                        "conversation_id": conv_id_raw,
                        "user_id": str(user_id),
                        "username": username,
                        "is_typing": is_typing,
                    })
            elif event_type == "read":
                try:
                    if hasattr(database, "messages") and hasattr(database.messages, "update_many"):
                        await database.messages.update_many(
                            {
                                "conversation_id": ObjectId(conv_id_raw),
                                "sender_id": {"$ne": user_id},
                                "read_by": {"$ne": user_id},
                            },
                            {
                                "$addToSet": {"read_by": user_id},
                                "$set": {"status": "read"},
                            },
                        )
                    if hasattr(database.conversation_memberships, "find"):
                        conv_members = await database.conversation_memberships.find(
                            {"conversation_id": ObjectId(conv_id_raw)}, {"user_id": 1}
                        ).to_list(length=200)
                        target_user_ids = [m["user_id"] for m in conv_members if m["user_id"] != user_id]
                        if target_user_ids:
                            await publish(target_user_ids, {
                                "type": "read_receipt",
                                "conversation_id": conv_id_raw,
                                "reader_id": str(user_id),
                            })
                except Exception:
                    pass
            elif event_type == "delivery_ack":
                msg_id_raw = event.get("message_id")
                if isinstance(msg_id_raw, str) and ObjectId.is_valid(msg_id_raw):
                    try:
                        if hasattr(database, "messages") and hasattr(database.messages, "update_one"):
                            await database.messages.update_one(
                                {"_id": ObjectId(msg_id_raw), "status": {"$ne": "read"}},
                                {
                                    "$addToSet": {"delivered_to": user_id},
                                    "$set": {"status": "delivered"},
                                },
                            )
                        if hasattr(database.conversation_memberships, "find"):
                            conv_members = await database.conversation_memberships.find(
                                {"conversation_id": ObjectId(conv_id_raw)}, {"user_id": 1}
                            ).to_list(length=200)
                            target_user_ids = [m["user_id"] for m in conv_members if m["user_id"] != user_id]
                            if target_user_ids:
                                await publish(target_user_ids, {
                                    "type": "message_delivered",
                                    "conversation_id": conv_id_raw,
                                    "message_id": msg_id_raw,
                                })
                    except Exception:
                        pass
    except (WebSocketDisconnect, json.JSONDecodeError):
        pass
    finally:
        connections[user_id].discard(queue)
        if not connections[user_id]:
            connections.pop(user_id, None)
            peer_ids = await get_user_peer_ids(user_id, database)
            if peer_ids:
                await publish(peer_ids, {"type": "presence", "user_id": str(user_id), "status": "offline"})
