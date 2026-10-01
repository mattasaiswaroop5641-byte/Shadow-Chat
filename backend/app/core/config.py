import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

UPLOADS_DIR = Path(__file__).resolve().parent.parent.parent / "uploads"


def get_uploads_dir() -> Path:
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    return UPLOADS_DIR



class Settings:
    app_name: str = "Shadow Chat API"
    app_env: str = os.getenv("APP_ENV", "development")
    debug: bool = app_env != "production"
    secret_key: str = os.getenv("SECRET_KEY", "change-me-in-production")
    algorithm: str = os.getenv("ALGORITHM", "HS256")
    jwt_issuer: str = os.getenv("JWT_ISSUER", "shadow-chat")
    jwt_audience: str = os.getenv("JWT_AUDIENCE", "shadow-chat-client")
    access_token_expire_minutes: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "30"))
    refresh_token_expire_days: int = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", "7"))
    max_request_body_bytes: int = int(os.getenv("MAX_REQUEST_BODY_BYTES", "1048576"))
    mongo_uri: str = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
    mongo_db: str = os.getenv("MONGODB_DB", "shadowchat")
    cors_origins: list[str] = [
        origin.strip().rstrip("/")
        for origin in os.getenv(
            "CORS_ORIGINS",
            "http://127.0.0.1:3000,http://localhost:3000,"
            "http://127.0.0.1:5173,http://localhost:5173",
        ).split(",")
        if origin.strip()
    ]
    websocket_origins: list[str] = [
        origin.strip().rstrip("/")
        for origin in os.getenv(
            "WEBSOCKET_ORIGINS",
            os.getenv(
                "CORS_ORIGINS",
                "http://127.0.0.1:3000,http://localhost:3000,"
                "http://127.0.0.1:5173,http://localhost:5173",
            ),
        ).split(",")
        if origin.strip()
    ]
    allowed_hosts: list[str] = [
        host.strip() for host in os.getenv("ALLOWED_HOSTS", "localhost,127.0.0.1").split(",") if host.strip()
    ]
    brevo_api_key: str = os.getenv("BREVO_API_KEY", "")
    brevo_sender_email: str = os.getenv("BREVO_SENDER_EMAIL", "")
    brevo_sender_name: str = os.getenv("BREVO_SENDER_NAME", "Shadow Chat")

    def validate(self) -> None:
        if self.app_env == "production" and (
            self.secret_key == "change-me-in-production" or len(self.secret_key) < 32
        ):
            raise RuntimeError("A strong SECRET_KEY is required in production")
        if not self.cors_origins:
            raise RuntimeError("At least one CORS origin is required")
        if "*" in self.cors_origins:
            raise RuntimeError("Wildcard CORS origins are not allowed")
        if not self.websocket_origins:
            raise RuntimeError("At least one WebSocket origin is required")
        if "*" in self.websocket_origins:
            raise RuntimeError("Wildcard WebSocket origins are not allowed")
        if self.algorithm not in {"HS256", "HS384", "HS512"}:
            raise RuntimeError("Unsupported JWT algorithm")
        if self.max_request_body_bytes <= 0:
            raise RuntimeError("MAX_REQUEST_BODY_BYTES must be positive")
        if self.app_env == "production" and (
            not self.brevo_api_key or not self.brevo_sender_email
        ):
            raise RuntimeError("Brevo email configuration is required in production")
        if self.app_env == "production" and not self.mongo_uri.startswith("mongodb+srv://"):
            raise RuntimeError("Production MongoDB must use an Atlas mongodb+srv URI")
        if self.access_token_expire_minutes <= 0 or self.access_token_expire_minutes > 60:
            raise RuntimeError("ACCESS_TOKEN_EXPIRE_MINUTES must be between 1 and 60")
        if self.refresh_token_expire_days <= 0 or self.refresh_token_expire_days > 30:
            raise RuntimeError("REFRESH_TOKEN_EXPIRE_DAYS must be between 1 and 30")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
