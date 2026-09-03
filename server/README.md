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

## API Endpoints

| Method | Path                          | Description                              |
|--------|-------------------------------|------------------------------------------|
| GET    | `/api/health`                 | Health check (safe config diagnostics)   |
| GET    | `/auth/pinterest`             | Start OAuth flow (redirects to Pinterest)|
| GET    | `/auth/pinterest/callback`    | OAuth callback (Pinterest redirects here)|
| GET    | `/api/pinterest/status`       | Check connection status                  |
| POST   | `/api/pinterest/disconnect`   | Clear stored session/token               |
| GET    | `/api/pinterest/boards`       | List authenticated user's boards         |
| POST   | `/api/pinterest/boards`       | Create a new board                       |
| POST   | `/api/pinterest/pins`         | Create a new pin                         |

## Cross-Origin Session Handling

The frontend is hosted on GitHub Pages (`https://shehrozali6465372-ctrl.github.io/modern-living-hub`)
and the backend runs on a separate domain. This requires:

- **CORS** allows only the derived origin from `FRONTEND_URL` (no wildcards, credentials enabled).
- **Session cookies** use `SameSite=None` + `Secure=true` in production so
  the browser sends the session cookie on cross-origin API requests from the frontend.

In production (`NODE_ENV=production`):
- `SameSite=None` — cookie sent on all cross-origin requests
- `Secure=true` — cookie only sent over HTTPS (required by browsers for SameSite=None)

In development (`NODE_ENV=development`):
- `SameSite=lax` — sufficient for localhost
- `Secure=false` — allows HTTP

## Security

- `PINTEREST_CLIENT_SECRET` is never sent to the frontend.
- Access tokens are stored server-side in an ephemeral tokenStore (in-memory Map), NOT in the session cookie.
- The session cookie only contains an opaque sessionId and oauth_state (both signed).
- Pinterest access_token and refresh_token are never exposed to the browser or frontend.
- On Render Free tier, tokens are lost if the process restarts (user reconnects automatically).
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
