from __future__ import annotations

import httpx

from app.core.config import get_settings

settings = get_settings()


class MailDeliveryError(RuntimeError):
    pass


async def send_transactional_email(
    recipient: str,
    subject: str,
    html_content: str,
) -> None:
    if not settings.brevo_api_key or not settings.brevo_sender_email:
        raise MailDeliveryError("Transactional email is not configured")

    payload = {
        "sender": {
            "name": settings.brevo_sender_name,
            "email": settings.brevo_sender_email,
        },
        "to": [{"email": recipient}],
        "subject": subject,
        "htmlContent": html_content,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                "https://api.brevo.com/v3/smtp/email",
                headers={
                    "accept": "application/json",
                    "api-key": settings.brevo_api_key,
                    "content-type": "application/json",
                },
                json=payload,
            )
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise MailDeliveryError("Transactional email delivery failed") from exc
