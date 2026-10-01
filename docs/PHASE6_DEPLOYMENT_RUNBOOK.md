# Shadow Chat — Phase 6 Production Deployment Runbook

This runbook provides complete, step-by-step instructions to deploy Shadow Chat in production across the recommended modern cloud architecture:

| Component | Platform | Role |
|---|---|---|
| **Frontend** | **Vercel** | Edge-accelerated React + Vite SPA with instant global CDN |
| **Backend** | **Render** | Asynchronous FastAPI (ASGI) web service running on Python 3.11 |
| **Database** | **MongoDB Atlas** | Managed, replicated cloud document store with TLS/SSL encryption |
| **Monitoring** | **UptimeRobot** | Continuous 5-min health polling (`/health`) to prevent sleep & monitor SLA |
| **WebSockets** | **Direct `wss://`** | High-performance duplex streaming directly from Vercel client to Render |

```mermaid
flowchart LR
    subgraph Users ["Client Devices"]
        BrowserA["Desktop / Mobile Browser"]
    end

    subgraph VercelEdge ["Vercel Global Edge"]
        SPA["React 18 SPA (Static Assets)"]
    end

    subgraph RenderCloud ["Render Web Service"]
        API["FastAPI REST Endpoints"]
        WSServer["WebSocket Server (wss://)"]
    end

    subgraph AtlasCloud ["MongoDB Atlas"]
        Cluster[("Production Replica Set")]
    end

    subgraph Monitoring ["UptimeRobot"]
        Ping["5-Min Health Ping (/health)"]
    end

    BrowserA -->|HTTPS: Load UI| SPA
    BrowserA -->|HTTPS REST: /auth, /conversations| API
    BrowserA -->|Direct WSS: /ws| WSServer
    API -->|Async Motor (TLS)| Cluster
    Ping -->|Keeps Render Warm & Tracks Uptime| API
```

---

## Pre-Requisites

Before starting deployment, ensure you have:
1. Access to GitHub repository: [https://github.com/mattasaiswaroop5641-byte/Shadow-Chat](https://github.com/mattasaiswaroop5641-byte/Shadow-Chat)
2. A free or paid account on [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
3. An account on [Render](https://render.com)
4. An account on [Vercel](https://vercel.com)
5. An account on [UptimeRobot](https://uptimerobot.com)
6. A free account on [Brevo](https://www.brevo.com) (formerly Sendinblue) for OTP verification emails

---

## Step 1: MongoDB Atlas Configuration

1. **Create or Select a Cluster:**
   - Log in to MongoDB Atlas and navigate to **Database Deployments**.
   - Create a free `M0` sandbox or standard `M10+` dedicated cluster.
2. **Configure Database User:**
   - Go to **Security > Database Access**.
   - Click **Add New Database User**.
   - Choose **Password Authentication**, set a strong username (e.g. `shadowchat_app`) and secure password.
   - Assign user privileges: **Read and write to any database** (or restrict to `shadowchat` database).
3. **Configure IP Access List:**
   - Go to **Security > Network Access**.
   - Click **Add IP Address**.
   - Select **Allow Access From Anywhere** (`0.0.0.0/0`).
   - *(Note: Render dynamic cloud instances require `0.0.0.0/0` unless you configure a static egress IP).*
4. **Copy Connection String:**
   - Click **Connect > Drivers (Python > Motor/PyMongo)**.
   - Copy the SRV URI:
     ```text
     mongodb+srv://shadowchat_app:<password>@<cluster-name>.mongodb.net/shadowchat?retryWrites=true&w=majority
     ```

---

## Step 2: Render Backend Deployment

1. **Log in to Render Dashboard:**
   - Go to [dashboard.render.com](https://dashboard.render.com).
2. **Create New Web Service:**
   - Click **New + > Web Service**.
   - Connect your GitHub account and select repository `mattasaiswaroop5641-byte/Shadow-Chat`.
3. **Configure Service Details:**
   - **Name:** `shadow-chat-api` (or custom name)
   - **Region:** Select the region closest to your users (e.g. `Singapore` or `Frankfurt` or `Oregon`).
   - **Root Directory:** `backend`
   - **Runtime:** `Python 3`
   - **Build Command:** `pip install --requirement requirements.txt`
   - **Start Command:** `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
4. **Configure Environment Variables:**
   Under **Environment Variables**, add the following:

   | Key | Value | Notes |
   |---|---|---|
   | `APP_ENV` | `production` | Enforces TLS, strict CORS, and security middleware |
   | `PYTHON_VERSION` | `3.11.6` | Specifies Python 3.11 runtime |
   | `MONGODB_URI` | `mongodb+srv://...` | Your Atlas connection string from Step 1 |
   | `MONGODB_DB` | `shadowchat` | Database name |
   | `SECRET_KEY` | *(generate 64-char hex)* | Run `python -c "import secrets; print(secrets.token_hex(32))"` |
   | `JWT_ISSUER` | `shadow-chat` | Issuer claim verification |
   | `JWT_AUDIENCE` | `shadow-chat-client` | Audience claim verification |
   | `ACCESS_TOKEN_EXPIRE_MINUTES` | `30` | 30 minutes |
   | `REFRESH_TOKEN_EXPIRE_DAYS` | `7` | 7 days |
   | `MAX_REQUEST_BODY_BYTES` | `1048576` | 1 MB |
   | `BREVO_API_KEY` | `xkeysib-...` | Your Brevo transactional API key |
   | `BREVO_SENDER_EMAIL` | `noreply@yourdomain.com` | Verified Brevo sender address |
   | `BREVO_SENDER_NAME` | `Shadow Chat` | Display name in OTP emails |
   | `ALLOWED_HOSTS` | `shadow-chat-api.onrender.com,localhost,127.0.0.1,*.onrender.com` | Host header security check |
   | `CORS_ORIGINS` | `https://shadow-chat.vercel.app` *(update after Step 3)* | Frontend URL allowed for REST requests |
   | `WEBSOCKET_ORIGINS` | `https://shadow-chat.vercel.app` *(update after Step 3)* | Frontend URL allowed for WebSocket handshake |

5. **Deploy:**
   - Click **Deploy Web Service**.
   - Render will build and start your application.
   - Once live, verify by opening `https://<service-name>.onrender.com/health` in your browser. It should return:
     ```json
     {"status":"ok","database":"connected","service":"shadow-chat"}
     ```

---

## Step 3: Vercel Frontend Deployment

1. **Log in to Vercel Dashboard:**
   - Go to [vercel.com/dashboard](https://vercel.com/dashboard).
2. **Import Git Repository:**
   - Click **Add New... > Project**.
   - Select `mattasaiswaroop5641-byte/Shadow-Chat`.
3. **Configure Project Settings:**
   - **Framework Preset:** `Vite`
   - **Root Directory:** Click **Edit** and choose `frontend`.
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
4. **Configure Environment Variables:**
   - Add variable:
     - **Name:** `VITE_API_BASE_URL`
     - **Value:** `https://shadow-chat-api.onrender.com` (use your actual Render service URL from Step 2 without a trailing slash).
5. **Deploy:**
   - Click **Deploy**.
   - Vercel will install dependencies, compile TypeScript, build the Vite production bundle, and publish the site.
   - Your frontend URL will look like: `https://shadow-chat-<username>.vercel.app` (or custom domain).

---

## Step 4: Connect Vercel & Render (CORS & WebSockets)

Now that you have your Vercel URL, finalize the connection on Render:

1. Copy your Vercel deployment URL (e.g. `https://shadow-chat.vercel.app`).
2. Go to your Render backend dashboard: **Web Service > Environment**.
3. Update `CORS_ORIGINS`:
   ```text
   https://shadow-chat.vercel.app
   ```
4. Update `WEBSOCKET_ORIGINS`:
   ```text
   https://shadow-chat.vercel.app
   ```
5. Click **Save Changes**. Render will automatically redeploy with the updated origins.

---

## Step 5: Direct WebSocket (`wss://`) Connection Verification

In production, the frontend automatically routes WebSocket connections directly to Render over TLS:

1. When `VITE_API_BASE_URL` is `https://shadow-chat-api.onrender.com`, `frontend/src/lib/api.ts` converts `https://` to `wss://` and targets `/ws`:
   ```text
   wss://shadow-chat-api.onrender.com/ws
   ```
2. The browser automatically attaches the `Origin: https://shadow-chat.vercel.app` header to the WebSocket handshake.
3. Render accepts the TLS connection, checks `WEBSOCKET_ORIGINS`, verifies the JWT access token, and initiates bidirectional event streaming.
4. **How to verify in the browser:**
   - Open your Vercel frontend URL in Chrome/Firefox.
   - Press `F12` to open Developer Tools > **Network** tab > filter by **WS**.
   - Log in or register an account.
   - Inspect the `/ws` entry:
     - Status: `101 Switching Protocols`
     - Request URL: `wss://shadow-chat-api.onrender.com/ws`
     - Messages tab: Check for incoming `{"type": "subscribed"}` and `{"type": "message"}` events.

---

## Step 6: UptimeRobot Monitoring Setup

Render's free tier spins down services after 15 minutes of inactivity. Setting up UptimeRobot prevents sleep cycles, eliminates cold-starts, and provides instant downtime alerting:

1. **Log in to UptimeRobot:**
   - Go to [uptimerobot.com/dashboard](https://uptimerobot.com/dashboard).
2. **Add New Monitor:**
   - Click **+ Add New Monitor**.
   - **Monitor Type:** `HTTP(s)`
   - **Friendly Name:** `Shadow Chat Backend Health`
   - **URL (or IP):** `https://shadow-chat-api.onrender.com/health`
   - **Monitoring Interval:** `Every 5 minutes` (free tier) or `Every 1 minute`
   - **Monitor Timeout:** `30 seconds`
3. **Select Alert Contacts:**
   - Select your email address or SMS/Webhook to receive instant notifications if the database or API ever goes down.
4. **Save Monitor:**
   - Click **Create Monitor**.
   - UptimeRobot will start pinging `/health` every 5 minutes.
   - Because `/health` runs a fast 2-second MongoDB ping (`await database.command("ping")`), UptimeRobot monitors both the web server **and** live Atlas database health!

---

## Step 7: End-to-End Production Verification Checklist

Run this quick test once all services are configured:

- [ ] **Database Connectivity:** Navigating to `https://<render-url>/health` returns `200 OK` with `{"status":"ok","database":"connected"}`.
- [ ] **Registration & Email OTP:** Register an account on the Vercel frontend and verify the 6-digit OTP code arrives via Brevo.
- [ ] **Login & Token Storage:** Log in with the verified account; confirm access token and refresh token are stored in localStorage/session.
- [ ] **Direct WebSocket Streaming:** Open a second browser in Incognito or on another device; create a DM or group and send a message. Verify the message appears instantly on both screens without refreshing.
- [ ] **Session Refresh:** Keep the session active; confirm token rotation happens transparently in the background.
- [ ] **SPA Route Refresh:** Refresh any screen on Vercel; verify the application stays on the page without 404 errors (powered by `vercel.json`).
- [ ] **Uptime Status:** Check UptimeRobot dashboard to ensure the monitor reports `100% Up`.
