from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from app.core.config import get_settings

settings = get_settings()


def mongo_tls_enabled(mongo_uri: str, app_env: str) -> bool:
    return mongo_uri.startswith("mongodb+srv://") or app_env == "production"


client = AsyncIOMotorClient(
    settings.mongo_uri,
    serverSelectionTimeoutMS=5000,
    connectTimeoutMS=5000,
    socketTimeoutMS=10000,
    tls=mongo_tls_enabled(settings.mongo_uri, settings.app_env),
)
database = client[settings.mongo_db]


@asynccontextmanager
async def lifespan(_: Any) -> AsyncIterator[None]:
    await database.users.create_index("email", unique=True)
    await database.users.create_index("username_lower", unique=True)
    await database.sessions.create_index("token_hash", unique=True)
    await database.sessions.create_index("expires_at", expireAfterSeconds=0)
    await database.revoked_refresh_tokens.create_index("token_hash", unique=True)
    await database.revoked_refresh_tokens.create_index("expires_at", expireAfterSeconds=0)
    await database.conversations.create_index("owner_id")
    await database.conversations.create_index("updated_at")
    await database.conversation_memberships.create_index(
        [("conversation_id", 1), ("user_id", 1)], unique=True
    )
    await database.conversation_memberships.create_index(
        [("user_id", 1), ("created_at", -1)]
    )
    await database.messages.create_index([("conversation_id", 1), ("created_at", -1)])
    await database.security_events.create_index("created_at", expireAfterSeconds=90 * 24 * 60 * 60)
    await database.security_events.create_index([("user_id", 1), ("created_at", -1)])
    await database.email_otps.create_index("expires_at", expireAfterSeconds=0)
    await database.email_otps.create_index(
        [("user_id", 1), ("purpose", 1), ("created_at", -1)]
    )
    await database.password_resets.create_index("expires_at", expireAfterSeconds=0)
    await database.password_resets.create_index("token_hash", unique=True)
    yield
    client.close()


def get_database() -> AsyncIOMotorDatabase:
    return database
