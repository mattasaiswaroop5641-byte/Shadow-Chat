import asyncio
from app.main import health, liveness


class HealthyDatabase:
    async def command(self, cmd: str) -> dict:
        if cmd == "ping":
            return {"ok": 1.0}
        raise NotImplementedError


class UnhealthyDatabase:
    async def command(self, cmd: str) -> dict:
        raise ConnectionError("Simulated connection failure")


class TimingOutDatabase:
    async def command(self, cmd: str) -> dict:
        await asyncio.sleep(5.0)
        return {"ok": 1.0}


def test_health_success_when_database_reachable() -> None:
    db = HealthyDatabase()
    response = asyncio.run(health(database=db))
    assert response.status_code == 200
    import json
    data = json.loads(response.body.decode())
    assert data == {"status": "ok", "database": "connected", "service": "shadow-chat"}


def test_health_failure_when_database_unreachable() -> None:
    db = UnhealthyDatabase()
    response = asyncio.run(health(database=db))
    assert response.status_code == 503
    import json
    data = json.loads(response.body.decode())
    assert data == {"status": "unavailable", "database": "disconnected", "service": "shadow-chat"}


def test_health_timeout_when_database_hangs() -> None:
    db = TimingOutDatabase()
    response = asyncio.run(health(database=db))
    assert response.status_code == 503
    import json
    data = json.loads(response.body.decode())
    assert data["status"] == "unavailable"
    assert data["database"] == "disconnected"


def test_liveness_returns_alive() -> None:
    res = liveness()
    assert res == {"status": "alive", "service": "shadow-chat"}
