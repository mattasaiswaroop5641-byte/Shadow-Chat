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
    return origin is None or origin in settings.websocket_origins


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
    connections[user_id].add(queue)
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
            if not isinstance(event, dict) or event.get("type") != "subscribe":
                await websocket.close(code=1008)
                return
            if not isinstance(event.get("conversation_id"), str) or not ObjectId.is_valid(
                event["conversation_id"]
            ):
                await websocket.close(code=1008)
                return
            membership = await database.conversation_memberships.find_one(
                {
                    "conversation_id": ObjectId(event["conversation_id"]),
                    "user_id": user_id,
                }
            )
            if membership is None:
                await websocket.close(code=1008)
                return
            await websocket.send_json({"type": "subscribed", "conversation_id": event["conversation_id"]})
    except (WebSocketDisconnect, json.JSONDecodeError):
        pass
    finally:
        connections[user_id].discard(queue)
        if not connections[user_id]:
            connections.pop(user_id, None)
