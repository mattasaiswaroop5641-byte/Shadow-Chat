import asyncio
import json
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from bson import ObjectId

from app.core.security import create_access_token
from app.routes.websocket import (
    allow_connection_attempt,
    connections,
    is_allowed_origin,
    publish,
    websocket_endpoint,
)


class MockWebSocket:
    def __init__(self, incoming_events: list[Any], origin: str | None = 'http://localhost:3000', client_host: str = '127.0.0.1') -> None:
        self.incoming = list(incoming_events)
        self.sent: list[Any] = []
        self.closed_code: int | None = None
        self.headers = {'origin': origin} if origin else {}
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
        await asyncio.sleep(10.0)
        return ''

    async def send_text(self, text: str) -> None:
        self.sent.append(text)

    async def send_json(self, data: Any) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000) -> None:
        self.closed_code = code


class MockCollection:
    def __init__(self, docs: list[dict[str, Any]] | None = None) -> None:
        self.docs = docs or []

    async def find_one(self, query: dict[str, Any]) -> dict[str, Any] | None:
        for doc in self.docs:
            if all(doc.get(k) == v for k, v in query.items()):
                return doc
        return None


class MockDatabase:
    def __init__(self, users: list[dict[str, Any]] | None = None, memberships: list[dict[str, Any]] | None = None) -> None:
        self.users = MockCollection(users)
        self.conversation_memberships = MockCollection(memberships)


def test_websocket_rejects_unauthenticated_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    db = MockDatabase()
    monkeypatch.setattr('app.routes.websocket.get_database', lambda: db)

    ws = MockWebSocket(incoming_events=[{'type': 'not_auth'}])
    asyncio.run(websocket_endpoint(ws))

    assert ws.accepted is True
    assert ws.closed_code == 1008


def test_websocket_rejects_non_member_subscription(monkeypatch: pytest.MonkeyPatch) -> None:
    user_id = ObjectId()
    token = create_access_token(str(user_id))
    db = MockDatabase(
        users=[{'_id': user_id}],
        memberships=[],  # User has no memberships
    )
    monkeypatch.setattr('app.routes.websocket.get_database', lambda: db)

    target_conv_id = str(ObjectId())
    ws = MockWebSocket(incoming_events=[
        {'type': 'auth', 'access_token': token},
        {'type': 'subscribe', 'conversation_id': target_conv_id},
    ])
    asyncio.run(websocket_endpoint(ws))

    assert ws.closed_code == 1008


def test_websocket_subscribes_member_and_sends_confirmation(monkeypatch: pytest.MonkeyPatch) -> None:
    user_id = ObjectId()
    conv_id = ObjectId()
    token = create_access_token(str(user_id))
    db = MockDatabase(
        users=[{'_id': user_id}],
        memberships=[{'conversation_id': conv_id, 'user_id': user_id}],
    )
    monkeypatch.setattr('app.routes.websocket.get_database', lambda: db)

    ws = MockWebSocket(incoming_events=[
        {'type': 'auth', 'access_token': token},
        {'type': 'subscribe', 'conversation_id': str(conv_id)},
    ])

    async def run_with_timeout() -> None:
        try:
            await asyncio.wait_for(websocket_endpoint(ws), timeout=0.1)
        except asyncio.TimeoutError:
            pass

    asyncio.run(run_with_timeout())
    assert any(msg == {'type': 'subscribed', 'conversation_id': str(conv_id)} for msg in ws.sent)


def test_connection_attempt_rate_limiting() -> None:
    ip = f'192.168.1.{uuid4().hex[:4]}'
    # 30 connection attempts allowed in window
    for _ in range(30):
        assert allow_connection_attempt(ip) is True
    # 31st attempt rejected
    assert allow_connection_attempt(ip) is False


def test_publish_delivers_event_and_handles_drop() -> None:
    user_id = ObjectId()
    queue: asyncio.Queue[str] = asyncio.Queue(maxsize=2)
    connections[user_id].add(queue)

    try:
        event = {
            'type': 'message',
            'conversation_id': '507f1f77bcf86cd799439011',
            'message': {'id': '123', 'content': 'hello'},
        }
        asyncio.run(publish([user_id], event))
        assert not queue.empty()
        data = json.loads(asyncio.run(queue.get()))
        assert data['type'] == 'message'
        assert data['message']['content'] == 'hello'
    finally:
        connections.pop(user_id, None)
