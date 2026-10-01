import logging
from datetime import datetime, timezone
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase

logger = logging.getLogger("shadow_chat.security")


async def record_security_event(
    database: AsyncIOMotorDatabase,
    *,
    event_type: str,
    user_id: Any | None = None,
    request_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    event = {
        "event_type": event_type,
        "user_id": user_id,
        "request_id": request_id,
        "metadata": metadata or {},
        "created_at": datetime.now(timezone.utc),
    }
    await database.security_events.insert_one(event)
    logger.info(
        "security_event event_type=%s user_id_present=%s request_id_present=%s",
        event_type,
        user_id is not None,
        request_id is not None,
    )
