# Shadow Chat

> Enterprise-grade, privacy-first, real-time messaging platform built with FastAPI, React, TypeScript, and MongoDB Atlas.

[![Security Checks](https://github.com/mattasaiswaroop5641-byte/Shadow-Chat/actions/workflows/security.yml/badge.svg)](https://github.com/mattasaiswaroop5641-byte/Shadow-Chat/actions/workflows/security.yml)
[![Python](https://img.shields.io/badge/Python-3.11-blue.svg)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-009688.svg)](https://fastapi.tiangolo.com)
[![React](https://img.shields.io/badge/React-18.3-61dafb.svg)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6.svg)](https://typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Features

- **Real-Time Duplex Messaging:** Native WebSocket streaming with token-based authentication and connection rate-limiting.
- **Participant Management:** Direct Messaging (DMs) with duplicate-conversation prevention, multi-user Group channels, and dynamic invitations with configurable invite policies (`all_members` vs `owner_only`).
- **Hardened Authentication:** RFC 9106 Argon2id password hashing, claim-bound JWT access tokens, single-use refresh token rotation with automated reuse detection and account-wide session revocation.
- **Zero-Trust Authorization (Anti-IDOR):** Robust database barriers across conversations, message history, and member directories.
- **Privacy-Preserving User Discovery:** Prefix-based user search omitting sensitive credentials and internal identifiers.
- **Abuse & Failure Defense:** Whitespace message sanitization, 4,000-char message caps, 64KB HTTP payload limit middleware, and WebSocket frame bounds (1009/1008).
- **Comprehensive Quality Assurance:** 73 passing automated tests covering auth, WebSockets, participant management, database configurations, and security audits.

---

## Tech Stack

| Layer | Technologies |
|---|---|
| **Frontend** | React 18, TypeScript, Tailwind CSS, Vite, Lucide Icons |
| **Backend** | FastAPI, Uvicorn (ASGI), Motor, PyMongo, Pydantic v2, SlowApi |
| **Database** | MongoDB Atlas (Replica Set with TLS/SSL encryption) |
| **Security** | Argon2-cffi, PyJWT, SlowApi Rate Limiter |
| **Deployment** | Vercel (Frontend), Render (Backend), UptimeRobot (Monitoring) |

---

## Architecture Overview

```mermaid
flowchart LR
    Browser["Client Device"] -->|HTTPS (SPA Assets)| Vercel["Vercel Global CDN (Frontend)"]
    Browser -->|HTTPS REST: /auth, /conversations| Render["Render Web Service (FastAPI)"]
    Browser -->|Direct WSS: /ws| Render
    Render -->|TLS SRV Connection| Atlas[("MongoDB Atlas Cloud")]
    UptimeRobot["UptimeRobot (5-Min Ping)"] -->|GET /health| Render
```

---

## Getting Started

### Prerequisites
- Python 3.11+
- Node.js 20+ & npm
- MongoDB Atlas cluster (or local MongoDB 7.0+)

### Backend Setup
```bash
cd backend
python -m venv venv
# Windows:
venv\Scripts\activate
# Linux/macOS:
source venv/bin/activate

pip install -r requirements.txt
cp ../.env.example .env
# Edit .env with your MongoDB Atlas URI, SECRET_KEY, and Brevo credentials

uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### Running Backend Tests
```bash
cd backend
pytest -v
```

### Frontend Setup
```bash
cd frontend
npm install
npm run dev
```

### Building for Production
```bash
cd frontend
npm run build
```

---

## Production Deployment (Phase 6 Architecture)

Complete step-by-step production runbooks are available in [`docs/PHASE6_DEPLOYMENT_RUNBOOK.md`](docs/PHASE6_DEPLOYMENT_RUNBOOK.md):
- **Frontend on Vercel:** Configured via `frontend/vercel.json` with SPA route rewrites and security headers.
- **Backend on Render:** Configured via `render.yaml` with Python 3.11 and health probe `/health`.
- **Database on MongoDB Atlas:** TLS SRV connection with replica-set redundancy and compound unique constraints.
- **Monitoring on UptimeRobot:** 5-minute health polling on `/health` to eliminate free-tier sleep cycles.

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
