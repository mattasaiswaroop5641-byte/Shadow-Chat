import asyncio
import json
from types import SimpleNamespace
from typing import Any
import pytest
from bson import ObjectId

from app.core.security import create_access_token
from app.routes.websocket import (
    connections,
    is_user_online,
    publish,
    websocket_endpoint,
)


class MockWebSocket:
    def __init__(self, incoming: list[Any], origin: str = "http://localhost:3000", client_host: str = "127.0.0.1") -> None:
        self.incoming = list(incoming)
        self.sent: list[Any] = []
        self.closed_code: int | None = None
        self.headers = {"origin": origin}
        self.client = SimpleNamespace(host=client_host)
        self.accepted = False

    async def accept(self) -> None:
        self.accepted = True

    async def receive_json(self) -> Any:
        if self.incoming:
            return self.incoming.pop(0)
        raise asyncio.TimeoutError()

    async def receive_text(self) -> str:
        if self.incoming:
            item = self.incoming.pop(0)
            return json.dumps(item) if not isinstance(item, str) else item
        await asyncio.sleep(5.0)
        return ""

    async def send_text(self, text: str) -> None:
        self.sent.append(text)

    async def send_json(self, data: Any) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000) -> None:
        self.closed_code = code


class MockCursor:
    def __init__(self, items: list[dict[str, Any]]) -> None:
        self.items = items

    async def to_list(self, length: int) -> list[dict[str, Any]]:
        return self.items[:length]


class MockCollection:
    def __init__(self, docs: list[dict[str, Any]] | None = None) -> None:
        self.docs = docs or []

    async def find_one(self, query: dict[str, Any], projection: dict[str, Any] | None = None) -> dict[str, Any] | None:
        for doc in self.docs:
            if all(doc.get(k) == v for k, v in query.items() if not k.startswith("$")):
                return doc
        return None

    def find(self, query: dict[str, Any], projection: dict[str, Any] | None = None) -> MockCursor:
        matched = []
        for doc in self.docs:
            match = True
            for k, v in query.items():
                if k == "$in":
                    continue
                if isinstance(v, dict) and "$in" in v:
                    if doc.get(k) not in v["$in"]:
                        match = False
                        break
                elif doc.get(k) != v:
                    match = False
                    break
            if match:
                matched.append(doc)
        return MockCursor(matched)

    async def update_many(self, query: dict[str, Any], update: dict[str, Any]) -> SimpleNamespace:
        count = 0
        for doc in self.docs:
            match = True
            for k, v in query.items():
                if isinstance(v, dict) and "$ne" in v:
                    val = doc.get(k)
                    if isinstance(val, list):
                        if v["$ne"] in val:
                            match = False
                            break
                    elif val == v["$ne"]:
                        match = False
                        break
                elif doc.get(k) != v:
                    match = False
                    break
            if match:
                count += 1
                if "$set" in update:
                    doc.update(update["$set"])
                if "$addToSet" in update:
                    for field, item in update["$addToSet"].items():
                        if field not in doc or not isinstance(doc[field], list):
                            doc[field] = []
                        if item not in doc[field]:
                            doc[field].append(item)
        return SimpleNamespace(modified_count=count)

    async def update_one(self, query: dict[str, Any], update: dict[str, Any]) -> SimpleNamespace:
        doc = await self.find_one(query)
        if doc:
            if "$set" in update:
                doc.update(update["$set"])
            if "$addToSet" in update:
                for field, item in update["$addToSet"].items():
                    if field not in doc or not isinstance(doc[field], list):
                        doc[field] = []
                    if item not in doc[field]:
                        doc[field].append(item)
            return SimpleNamespace(modified_count=1)
        return SimpleNamespace(modified_count=0)


class MockDatabase:
    def __init__(self, users: list[dict[str, Any]], memberships: list[dict[str, Any]], messages: list[dict[str, Any]] | None = None) -> None:
        self.users = MockCollection(users)
        self.conversation_memberships = MockCollection(memberships)
        self.messages = MockCollection(messages or [])


def test_typing_indicator_broadcasts_to_conversation_peers(monkeypatch: pytest.MonkeyPatch) -> None:
    alice_id = ObjectId()
    bob_id = ObjectId()
    conv_id = ObjectId()

    alice_token = create_access_token(str(alice_id))
    db = MockDatabase(
        users=[
            {"_id": alice_id, "username": "alice"},
            {"_id": bob_id, "username": "bob"},
        ],
        memberships=[
            {"conversation_id": conv_id, "user_id": alice_id},
            {"conversation_id": conv_id, "user_id": bob_id},
        ],
    )
    monkeypatch.setattr("app.routes.websocket.get_database", lambda: db)

    # Bob has an active queue listening
    bob_queue: asyncio.Queue[str] = asyncio.Queue()
    connections[bob_id].add(bob_queue)

    try:
        alice_ws = MockWebSocket(incoming=[
            {"type": "auth", "access_token": alice_token},
            {"type": "typing", "conversation_id": str(conv_id), "is_typing": True},
        ])

        async def run_alice() -> None:
            try:
                await asyncio.wait_for(websocket_endpoint(alice_ws), timeout=0.15)
            except asyncio.TimeoutError:
                pass

        asyncio.run(run_alice())

        # Check that Bob received the typing broadcast
        events = []
        while not bob_queue.empty():
            events.append(json.loads(bob_queue.get_nowait()))
        typing_event = next((e for e in events if e.get("type") == "typing"), None)
        assert typing_event is not None
        assert typing_event["conversation_id"] == str(conv_id)
        assert typing_event["user_id"] == str(alice_id)
        assert typing_event["username"] == "alice"
        assert typing_event["is_typing"] is True
    finally:
        connections[bob_id].discard(bob_queue)


def test_read_receipt_updates_messages_and_broadcasts(monkeypatch: pytest.MonkeyPatch) -> None:
    alice_id = ObjectId()
    bob_id = ObjectId()
    conv_id = ObjectId()

    bob_token = create_access_token(str(bob_id))
    msg_id = ObjectId()
    db = MockDatabase(
        users=[
            {"_id": alice_id, "username": "alice"},
            {"_id": bob_id, "username": "bob"},
        ],
        memberships=[
            {"conversation_id": conv_id, "user_id": alice_id},
            {"conversation_id": conv_id, "user_id": bob_id},
        ],
        messages=[
            {
                "_id": msg_id,
                "conversation_id": conv_id,
                "sender_id": alice_id,
                "content": "Hello Bob",
                "status": "delivered",
                "read_by": [],
            }
        ],
    )
    monkeypatch.setattr("app.routes.websocket.get_database", lambda: db)

    # Alice has an active queue listening
    alice_queue: asyncio.Queue[str] = asyncio.Queue()
    connections[alice_id].add(alice_queue)

    try:
        bob_ws = MockWebSocket(incoming=[
            {"type": "auth", "access_token": bob_token},
            {"type": "read", "conversation_id": str(conv_id)},
        ])

        async def run_bob() -> None:
            try:
                await asyncio.wait_for(websocket_endpoint(bob_ws), timeout=0.15)
            except asyncio.TimeoutError:
                pass

        asyncio.run(run_bob())

        # Alice must receive read_receipt
        events = []
        while not alice_queue.empty():
            events.append(json.loads(alice_queue.get_nowait()))
        read_event = next((e for e in events if e.get("type") == "read_receipt"), None)
        assert read_event is not None
        assert read_event["conversation_id"] == str(conv_id)
        assert read_event["reader_id"] == str(bob_id)

        # Message status must be updated in DB
        msg = db.messages.docs[0]
        assert msg["status"] == "read"
        assert bob_id in msg["read_by"]
    finally:
        connections[alice_id].discard(alice_queue)


def test_presence_status_and_lifecycle(monkeypatch: pytest.MonkeyPatch) -> None:
    user_id = ObjectId()
    peer_id = ObjectId()
    conv_id = ObjectId()
    token = create_access_token(str(user_id))

    db = MockDatabase(
        users=[{"_id": user_id, "username": "active_user"}, {"_id": peer_id, "username": "peer"}],
        memberships=[
            {"conversation_id": conv_id, "user_id": user_id},
            {"conversation_id": conv_id, "user_id": peer_id},
        ],
    )
    monkeypatch.setattr("app.routes.websocket.get_database", lambda: db)

    peer_queue: asyncio.Queue[str] = asyncio.Queue()
    connections[peer_id].add(peer_queue)

    try:
        assert is_user_online(user_id) is False

        ws = MockWebSocket(incoming=[
            {"type": "auth", "access_token": token},
        ])

        async def run_ws() -> None:
            try:
                await asyncio.wait_for(websocket_endpoint(ws), timeout=0.15)
            except asyncio.TimeoutError:
                pass

        asyncio.run(run_ws())

        # Peer received "online" presence event
        received_types = []
        while not peer_queue.empty():
            ev = json.loads(peer_queue.get_nowait())
            received_types.append((ev.get("type"), ev.get("status")))

        assert ("presence", "online") in received_types
        # And after WS closed, received "offline"
        assert ("presence", "offline") in received_types
        assert is_user_online(user_id) is False
    finally:
        connections[peer_id].discard(peer_queue)
