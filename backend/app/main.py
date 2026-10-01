from __future__ import annotations

import asyncio
import os
from pathlib import Path as PathLib
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from motor.motor_asyncio import AsyncIOMotorDatabase
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import Response
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.core.config import get_settings, get_uploads_dir
from app.core.database import get_database, lifespan
from app.routes.auth import router as auth_router
from app.routes.conversations import router as conversations_router
from app.routes.messages import router as messages_router
from app.routes.users import router as users_router
from app.routes.websocket import router as websocket_router

settings = get_settings()
settings.validate()
limiter = Limiter(key_func=get_remote_address, default_limits=["120/minute"])


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["X-Permitted-Cross-Domain-Policies"] = "none"
        if settings.app_env == "production":
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
            response.headers["Content-Security-Policy"] = (
                "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; "
                "form-action 'none'; object-src 'none'; connect-src 'self' "
                + " ".join(settings.cors_origins)
                + "; img-src 'none'; style-src 'none'; script-src 'none'; font-src 'none';"
            )
        return response


class RequestSizeLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        content_length = request.headers.get("content-length")
        max_bytes = (
            15728640
            if ("/attachments" in request.url.path or "/avatar" in request.url.path)
            else settings.max_request_body_bytes
        )
        if content_length and int(content_length) > max_bytes:
            return JSONResponse(status_code=413, content={"detail": "Request body is too large"})
        return await call_next(request)

app = FastAPI(
    title="Shadow Chat API",
    version="0.1.0",
    description="Privacy-first messaging platform backend foundation.",
    lifespan=lifespan,
    docs_url=None if settings.app_env == "production" else "/docs",
    redoc_url=None if settings.app_env == "production" else "/redoc",
    openapi_url=None if settings.app_env == "production" else "/openapi.json",
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # type: ignore[arg-type]
app.add_middleware(SlowAPIMiddleware)
app.add_middleware(RequestSizeLimitMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(users_router)
app.include_router(conversations_router)
app.include_router(messages_router)
app.include_router(websocket_router)


@app.api_route("/health", methods=["GET", "HEAD"])
async def health(
    database: AsyncIOMotorDatabase = Depends(get_database),
) -> JSONResponse:
    try:
        await asyncio.wait_for(database.command("ping"), timeout=2.0)
        return JSONResponse(
            status_code=200,
            content={"status": "ok", "database": "connected", "service": "shadow-chat"},
        )
    except Exception:
        return JSONResponse(
            status_code=503,
            content={"status": "unavailable", "database": "disconnected", "service": "shadow-chat"},
        )


@app.api_route("/health/liveness", methods=["GET", "HEAD"])
def liveness() -> dict[str, str]:
    return {"status": "alive", "service": "shadow-chat"}


@app.get("/attachments/{filename}")
async def get_attachment_file(filename: str) -> FileResponse:
    safe_filename = os.path.basename(filename)
    file_path = get_uploads_dir() / safe_filename
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="Attachment not found")
    return FileResponse(file_path)


@app.api_route("/", methods=["GET", "HEAD"])
def index() -> dict[str, str]:
    return {"message": "Shadow Chat backend is running."}

