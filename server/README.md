# Modern Living Hub — Pinterest OAuth Backend

Node.js + Express backend that provides real Pinterest OAuth 2.0 authentication
and Pinterest API v5 integration for the Modern Living Hub website.

## Purpose

This backend enables:
- Pinterest OAuth 2.0 Authorization Code flow
- Listing the authenticated user's real Pinterest boards
- Creating real Pinterest boards
- Creating real Pinterest pins
- User-friendly API error handling
- Secure token storage (server-side only)

## Requirements

- Node.js 18 or higher
- A Pinterest Developer app with Standard Access
  (create one at https://developers.pinterest.com/apps/)

## Setup

```bash
cd server
npm install
cp .env.example .env
# Edit .env with your Pinterest app credentials
npm start
```

## Environment Variables

| Variable                  | Required | Description                                              |
|---------------------------|----------|----------------------------------------------------------|
| `PINTEREST_CLIENT_ID`     | Yes      | Pinterest app client ID (from Pinterest Developer Console) |
| `PINTEREST_CLIENT_SECRET` | Yes      | Pinterest app client secret (server-side only, never in frontend) |
| `PINTEREST_REDIRECT_URI`  | Yes      | Exact callback URL registered in Pinterest app settings  |
| `SESSION_SECRET`          | Yes      | Random string for session encryption                     |
| `FRONTEND_URL`            | Yes      | Full deployed frontend base URL including project path. e.g. `https://shehrozali6465372-ctrl.github.io/modern-living-hub`. CORS origin is derived from this automatically. |
| `PORT`                    | No       | Server port, defaults to 3001                            |
| `NODE_ENV`                | No       | Set to `production` for secure HTTPS cookies + SameSite=None |
| `TIKTOK_CLIENT_KEY`        | No       | TikTok app client key (for TikTok integration)             |
| `TIKTOK_CLIENT_SECRET`      | No       | TikTok app client secret (server-side only)               |
| `TIKTOK_REDIRECT_URI`       | No       | TikTok OAuth callback URL                                |
| `YOUTUBE_CLIENT_ID`         | No       | YouTube/Google OAuth client ID                            |
| `YOUTUBE_CLIENT_SECRET`     | No       | YouTube/Google OAuth client secret (server-side only)     |
| `YOUTUBE_REDIRECT_URI`      | No       | YouTube OAuth callback URL                                |

## How FRONTEND_URL Works

`FRONTEND_URL` is the **full deployed frontend base URL**, including the project path.

- **OAuth redirects** use `FRONTEND_URL` directly:
  `https://shehrozali6465372-ctrl.github.io/modern-living-hub/pinterest.html`

- **CORS** is derived from `new URL(FRONTEND_URL).origin`, so it allows:
  `https://shehrozali6465372-ctrl.github.io`
  (just the origin, without the project path)

This means the frontend can be served under a project subpath (like `/modern-living-hub`)
while CORS correctly allows requests from the GitHub Pages origin.

## Required Pinterest Scopes

The app requests these scopes only:
- `boards:read`
- `boards:write`
- `pins:read`
- `pins:write`

### Required YouTube Scopes

The YouTube integration requests these scopes only:
- `youtube.upload`

## API Endpoints

| Method | Path                          | Description                              |
|--------|-------------------------------|------------------------------------------|
| GET    | `/api/health`                 | Health check (safe config diagnostics)   |
| GET    | `/auth/pinterest`             | Start OAuth flow (redirects to Pinterest)|
| GET    | `/auth/pinterest/callback`    | OAuth callback (creates handoff code)    |
| POST   | `/api/pinterest/complete`     | Complete OAuth handoff → session token   |
| GET    | `/api/pinterest/status`       | Check connection status (Bearer or cookie)|
| POST   | `/api/pinterest/disconnect`   | Clear session token and Pinterest tokens |
| GET    | `/api/pinterest/boards`       | List authenticated user's boards         |
| POST   | `/api/pinterest/boards`       | Create a new board                       |
| POST   | `/api/pinterest/pins`         | Create a new pin                         |
| GET    | `/youtube/auth`               | Start YouTube OAuth flow                 |
| GET    | `/youtube/auth/callback`      | YouTube OAuth callback                   |
| POST   | `/api/youtube/complete`       | Complete YouTube handoff → session token |
| GET    | `/api/youtube/status`         | Check YouTube connection status          |
| GET    | `/api/youtube/channel`        | Get authenticated channel info           |
| POST   | `/api/youtube/upload`         | Upload video to YouTube                  |
| GET    | `/api/youtube/video-status/:id`| Check video processing status           |
| POST   | `/api/youtube/disconnect`     | Disconnect YouTube and clear tokens      |

## Cross-Origin Authentication

The frontend is hosted on GitHub Pages (`https://shehrozali6465372-ctrl.github.io/modern-living-hub`)
and the backend runs on a separate domain. Cross-site cookies are unreliable, so the app uses
a **one-time handoff code + bearer session token** architecture:

### OAuth Handoff Flow

1. User clicks "Connect Pinterest" → backend redirects to Pinterest OAuth
2. Pinterest redirects back to backend `/auth/pinterest/callback`
3. Backend exchanges code for access token, stores tokens server-side
4. Backend generates a **one-time random handoff code** (single-use, 5-minute TTL)
5. Backend redirects to `FRONTEND_URL/pinterest.html?pinterest_connected=1&handoff=<CODE>`
6. Frontend POSTs the handoff code to `POST /api/pinterest/complete`
7. Backend validates the code, creates a **bearer session token** (24-hour TTL)
8. Frontend stores the bearer token and sends it as `Authorization: Bearer <token>`
9. All subsequent API calls use the bearer token — **no cross-site cookies needed**

### Session Tokens

- Opaque, random, 64-character hex strings
- Server-side only (never exposed to third parties)
- 24-hour TTL with automatic expiry
- Single-use handoff codes (5-minute TTL)
- Bearer tokens invalidated on disconnect

## Security

- `PINTEREST_CLIENT_SECRET` is never sent to the frontend.
- Access tokens are stored server-side in an ephemeral tokenStore (in-memory Map).
- OAuth uses a **one-time handoff code** — tokens never appear in URLs or frontend responses.
- Bearer session tokens are opaque random hex strings, never Pinterest tokens.
- Pinterest access_token and refresh_token are NEVER exposed to the frontend JavaScript.
- Handoff codes are single-use with 5-minute TTL.
- Bearer session tokens have 24-hour TTL and are invalidated on disconnect.
- CORS allows `Authorization` header for cross-site bearer auth.
- OAuth `state` parameter is validated on callback (CSRF protection).
- All environment variables are loaded from `.env` (ignored by git).
- HTTPS is required in production.
- No access tokens or client secrets are logged.
- CORS is restricted to the exact frontend origin (no wildcards).

## Deployment

### Required Pinterest Developer App Configuration

1. Go to https://developers.pinterest.com/apps/
2. Create an app (or edit existing)
3. Set the **Redirect URI** to exactly:
   ```
   https://YOUR-BACKEND-DOMAIN.com/auth/pinterest/callback
   ```
4. Request Standard Access with scopes: `boards:read`, `boards:write`, `pins:read`, `pins:write`

### Deploying to Render (recommended)

1. Create an account at https://render.com
2. Create a new Web Service pointing to this repo
3. Build command: `cd server && npm install`
4. Start command: `cd server && npm start`
5. Add all environment variables in the Render dashboard:
   - `PINTEREST_CLIENT_ID`
   - `PINTEREST_CLIENT_SECRET`
   - `PINTEREST_REDIRECT_URI` = `https://modern-living-hub.onrender.com/auth/pinterest/callback`
   - `SESSION_SECRET` = (generate a random string)
   - `FRONTEND_URL` = `https://shehrozali6465372-ctrl.github.io/modern-living-hub`
   - `NODE_ENV` = `production`
6. Register `https://modern-living-hub.onrender.com/auth/pinterest/callback` in Pinterest

### Deploying to Railway

1. Create an account at https://railway.app
2. Create a new project and deploy this repo
3. Set the start command to `cd server && npm start`
4. Add all environment variables
5. Register `https://your-app.up.railway.app/auth/pinterest/callback` in Pinterest

### Deploying to a VPS / custom server

```bash
cd server
npm install --production
NODE_ENV=production FRONTEND_URL=https://shehrozali6465372-ctrl.github.io/modern-living-hub node src/server.js
```

Use Nginx reverse proxy with HTTPS enabled (e.g. via Let's Encrypt).

## Frontend Configuration

The frontend JavaScript (`assets/js/pinterest.js`) reads `window.BACKEND_URL`
set in each HTML page's inline script:

```html
<script>
  window.BACKEND_URL = 'https://modern-living-hub.onrender.com';
</script>
```

All API calls (OAuth, status, boards, pins, disconnect) use this single URL.
The `credentials: "include"` flag ensures the session cookie is sent.

If `BACKEND_URL` contains `YOUR-BACKEND` or is empty, the frontend shows
a configuration error instead of silently sending requests to GitHub Pages.

## YouTube Integration

### Required Google Cloud Console Configuration

1. Go to https://console.cloud.google.com/
2. Create a project or select an existing one
3. Enable the **YouTube Data API v3**
4. Create OAuth 2.0 credentials (Web application type)
5. Set the **Authorized redirect URI** to exactly:
   ```
   https://YOUR-BACKEND-DOMAIN.com/youtube/auth/callback
   ```
6. Note the Client ID and Client Secret

### Required YouTube Environment Variables

| Variable                | Description                                    |
|-------------------------|------------------------------------------------|
| `YOUTUBE_CLIENT_ID`     | Google OAuth client ID                         |
| `YOUTUBE_CLIENT_SECRET` | Google OAuth client secret (server-side only)  |
| `YOUTUBE_REDIRECT_URI`  | Exact callback URL registered in Google Console|

### YouTube Upload Behavior

- Videos are uploaded via multipart form-data (not base64 JSON)
- Supported privacy levels: `private`, `unlisted`, `public` (default: `private`)
- YouTube API may restrict `public` uploads pending channel audit
- The `madeForKids` flag maps to YouTube's `selfDeclaredMadeForKids`
- Category IDs map to YouTube's standard video categories (e.g., 22 = People & Blogs)

### YouTube Module Architecture

The YouTube integration is implemented as an isolated module (`server/src/youtube.js`)
that registers its own routes without modifying the core server logic.
