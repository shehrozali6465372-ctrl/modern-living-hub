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

| Variable                  | Description                                              |
|---------------------------|----------------------------------------------------------|
| `PINTEREST_CLIENT_ID`     | Pinterest app client ID (from Pinterest Developer Console) |
| `PINTEREST_CLIENT_SECRET` | Pinterest app client secret (server-side only, never in frontend) |
| `PINTEREST_REDIRECT_URI`  | Exact callback URL registered in Pinterest app settings  |
| `SESSION_SECRET`          | Random string for session encryption                     |
| `PORT`                    | (Optional) Server port, defaults to 3001                 |
| `NODE_ENV`                | (Optional) "production" enables secure HTTPS cookies     |

## Required Pinterest Scopes

The app requests these scopes only:
- `boards:read`
- `boards:write`
- `pins:read`
- `pins:write`

## API Endpoints

| Method | Path                          | Description                              |
|--------|-------------------------------|------------------------------------------|
| GET    | `/api/health`                 | Health check                             |
| GET    | `/auth/pinterest`             | Start OAuth flow (redirects to Pinterest)|
| GET    | `/auth/pinterest/callback`    | OAuth callback (Pinterest redirects here)|
| GET    | `/api/pinterest/status`       | Check connection status                  |
| POST   | `/api/pinterest/disconnect`   | Clear stored session/token               |
| GET    | `/api/pinterest/boards`       | List authenticated user's boards         |
| POST   | `/api/pinterest/boards`       | Create a new board                       |
| POST   | `/api/pinterest/pins`         | Create a new pin                         |

## Security

- `PINTEREST_CLIENT_SECRET` is never sent to the frontend.
- Access tokens are stored only in the server-side session.
- OAuth `state` parameter is validated on callback.
- All environment variables are loaded from `.env` (ignored by git).
- HTTPS is required in production (use secure cookies via `NODE_ENV=production`).
- No access tokens or client secrets are logged.

## Deployment

### Option 1: Deploy to Render (recommended)

1. Create an account at https://render.com
2. Create a new Web Service pointing to this repo
3. Build command: `cd server && npm install`
4. Start command: `cd server && npm start`
5. Add all environment variables in the Render dashboard
6. Set `PINTEREST_REDIRECT_URI` to `https://your-service.onrender.com/auth/pinterest/callback`
7. Register the same redirect URI in the Pinterest Developer Console

### Option 2: Deploy to Railway

1. Create an account at https://railway.app
2. Create a new project and deploy this repo
3. Set the start command to `cd server && npm start`
4. Add all environment variables
5. Register `https://your-app.up.railway.app/auth/pinterest/callback` in Pinterest

### Option 3: Deploy to a VPS / custom server

```bash
cd server
npm install --production
npm start
```

Use Nginx reverse proxy with HTTPS enabled.

## Frontend Configuration

The frontend JavaScript (`assets/js/pinterest.js`) connects to the backend
using the current origin by default (`BACKEND_URL` is empty).

- **If the frontend is served from the same domain as the backend:** no extra config needed.
- **If the frontend is on GitHub Pages and the backend is elsewhere:**
  add the backend URL as a global before the script loads:

```html
<script>window.BACKEND_URL = 'https://your-backend-domain.com';</script>
<script src="assets/js/pinterest.js" defer></script>
```

The backend's CORS allow-list must include the frontend domain.
