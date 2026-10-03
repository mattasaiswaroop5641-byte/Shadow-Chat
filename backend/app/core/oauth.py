from __future__ import annotations

import base64
import json
import logging
from typing import Any
import httpx
from pydantic import BaseModel

from app.core.config import get_settings

logger = logging.getLogger(__name__)


class OAuthUserInfo(BaseModel):
    provider: str
    provider_id: str
    email: str
    name: str | None = None
    username: str | None = None
    avatar_url: str | None = None
    email_verified: bool = True


PROVIDERS: dict[str, dict[str, Any]] = {
    "google": {
        "auth_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "userinfo_url": "https://www.googleapis.com/oauth2/v3/userinfo",
        "scopes": ["openid", "email", "profile"],
    },
    "github": {
        "auth_url": "https://github.com/login/oauth/authorize",
        "token_url": "https://github.com/login/oauth/access_token",
        "user_url": "https://api.github.com/user",
        "emails_url": "https://api.github.com/user/emails",
        "scopes": ["read:user", "user:email"],
    },
    "microsoft": {
        "auth_url": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        "token_url": "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        "userinfo_url": "https://graph.microsoft.com/v1.0/me",
        "scopes": ["openid", "email", "profile", "User.Read"],
    },
}


def is_provider_configured(provider: str) -> bool:
    settings = get_settings()
    if provider == "google":
        return bool(settings.google_client_id and settings.google_client_secret)
    if provider == "github":
        return bool(settings.github_client_id and settings.github_client_secret)
    if provider == "microsoft":
        return bool(settings.microsoft_client_id and settings.microsoft_client_secret)
    return False


def get_provider_credentials(provider: str) -> tuple[str, str]:
    settings = get_settings()
    if provider == "google":
        return settings.google_client_id, settings.google_client_secret
    if provider == "github":
        return settings.github_client_id, settings.github_client_secret
    if provider == "microsoft":
        return settings.microsoft_client_id, settings.microsoft_client_secret
    raise ValueError(f"Unknown OAuth provider: {provider}")


def encode_state(data: dict[str, Any]) -> str:
    raw = json.dumps(data).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def decode_state(state: str) -> dict[str, Any]:
    try:
        padding = 4 - (len(state) % 4)
        if padding != 4:
            state += "=" * padding
        raw = base64.urlsafe_b64decode(state.encode("utf-8"))
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return {}


def build_authorization_url(provider: str, redirect_uri: str, state: str) -> str:
    cfg = PROVIDERS.get(provider)
    if not cfg:
        raise ValueError(f"Unknown OAuth provider: {provider}")
    client_id, _ = get_provider_credentials(provider)
    scopes = " ".join(cfg["scopes"])

    params: dict[str, str] = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": scopes,
        "response_type": "code",
        "state": state,
    }
    if provider == "google":
        params["access_type"] = "offline"
        params["prompt"] = "select_account"
    elif provider == "microsoft":
        params["response_mode"] = "query"

    req = httpx.Request("GET", cfg["auth_url"], params=params)
    return str(req.url)


async def exchange_google_code(code: str, redirect_uri: str) -> OAuthUserInfo:
    client_id, client_secret = get_provider_credentials("google")
    async with httpx.AsyncClient(timeout=10.0) as client:
        token_resp = await client.post(
            PROVIDERS["google"]["token_url"],
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
            },
            headers={"Accept": "application/json"},
        )
        if token_resp.status_code != 200:
            logger.error("Google token exchange failed: %s", token_resp.text)
            raise ValueError(f"Failed to exchange code with Google: {token_resp.text}")
        tokens = token_resp.json()
        access_token = tokens.get("access_token")
        if not access_token:
            raise ValueError("No access token returned by Google")

        user_resp = await client.get(
            PROVIDERS["google"]["userinfo_url"],
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if user_resp.status_code != 200:
            raise ValueError("Failed to fetch user info from Google")
        user_data = user_resp.json()

        email = user_data.get("email")
        if not email:
            raise ValueError("Google account does not provide an email address")

        return OAuthUserInfo(
            provider="google",
            provider_id=str(user_data.get("sub", "")),
            email=email.lower(),
            name=user_data.get("name"),
            username=user_data.get("name") or email.split("@")[0],
            avatar_url=user_data.get("picture"),
            email_verified=bool(user_data.get("email_verified", True)),
        )


async def exchange_github_code(code: str, redirect_uri: str) -> OAuthUserInfo:
    client_id, client_secret = get_provider_credentials("github")
    async with httpx.AsyncClient(timeout=10.0) as client:
        token_resp = await client.post(
            PROVIDERS["github"]["token_url"],
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "redirect_uri": redirect_uri,
            },
            headers={"Accept": "application/json"},
        )
        if token_resp.status_code != 200:
            logger.error("GitHub token exchange failed: %s", token_resp.text)
            raise ValueError("Failed to exchange code with GitHub")
        tokens = token_resp.json()
        access_token = tokens.get("access_token")
        if not access_token:
            raise ValueError(tokens.get("error_description", "No access token returned by GitHub"))

        user_resp = await client.get(
            PROVIDERS["github"]["user_url"],
            headers={
                "Authorization": f"Bearer {access_token}",
                "User-Agent": "Shadow-Chat-OAuth",
                "Accept": "application/vnd.github.v3+json",
            },
        )
        if user_resp.status_code != 200:
            raise ValueError("Failed to fetch user info from GitHub")
        user_data = user_resp.json()

        email = user_data.get("email")
        if not email:
            # Query /user/emails
            emails_resp = await client.get(
                PROVIDERS["github"]["emails_url"],
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "User-Agent": "Shadow-Chat-OAuth",
                    "Accept": "application/vnd.github.v3+json",
                },
            )
            if emails_resp.status_code == 200:
                emails_list = emails_resp.json()
                for item in emails_list:
                    if item.get("primary") and item.get("verified"):
                        email = item.get("email")
                        break
                if not email and emails_list:
                    email = emails_list[0].get("email")

        if not email:
            raise ValueError(
                "GitHub account does not have a verified public email. "
                "Update your GitHub privacy settings to expose a verified email before continuing."
            )

        return OAuthUserInfo(
            provider="github",
            provider_id=str(user_data.get("id", "")),
            email=email.lower(),
            name=user_data.get("name") or user_data.get("login"),
            username=user_data.get("login"),
            avatar_url=user_data.get("avatar_url"),
            email_verified=True,
        )


async def exchange_microsoft_code(code: str, redirect_uri: str) -> OAuthUserInfo:
    client_id, client_secret = get_provider_credentials("microsoft")
    async with httpx.AsyncClient(timeout=10.0) as client:
        token_resp = await client.post(
            PROVIDERS["microsoft"]["token_url"],
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        if token_resp.status_code != 200:
            logger.error("Microsoft token exchange failed: %s", token_resp.text)
            raise ValueError("Failed to exchange code with Microsoft")
        tokens = token_resp.json()
        access_token = tokens.get("access_token")
        if not access_token:
            raise ValueError("No access token returned by Microsoft")

        user_resp = await client.get(
            PROVIDERS["microsoft"]["userinfo_url"],
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if user_resp.status_code != 200:
            raise ValueError("Failed to fetch user info from Microsoft")
        user_data = user_resp.json()

        email = user_data.get("mail") or user_data.get("userPrincipalName")
        if not email:
            raise ValueError("Microsoft account does not provide an email address")

        return OAuthUserInfo(
            provider="microsoft",
            provider_id=str(user_data.get("id", "")),
            email=email.lower(),
            name=user_data.get("displayName"),
            username=user_data.get("displayName") or email.split("@")[0],
            avatar_url=None,
            email_verified=True,
        )


async def exchange_oauth_code(provider: str, code: str, redirect_uri: str) -> OAuthUserInfo:
    if provider == "google":
        return await exchange_google_code(code, redirect_uri)
    if provider == "github":
        return await exchange_github_code(code, redirect_uri)
    if provider == "microsoft":
        return await exchange_microsoft_code(code, redirect_uri)
    raise ValueError(f"Unsupported OAuth provider: {provider}")
