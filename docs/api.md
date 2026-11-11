# API Documentation

## Overview

Modern Living Hub provides RESTful APIs for multi-platform content publishing via Pinterest, TikTok, and YouTube integrations.

## Authentication

- **Pinterest**: OAuth 2.0 with one-time handoff + bearer session token
- **TikTok**: OAuth 2.0 with encrypted token cookie
- **YouTube**: OAuth 2.0 with one-time handoff + bearer session token

All authenticated endpoints require the platform-specific bearer session token or encrypted cookie.

## Backend Base URL

The backend is hosted at `https://modern-living-hub.onrender.com`.

## Platform Endpoints

### Health Check

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check with safe config diagnostics |

### Pinterest

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/auth/pinterest` | No | Start Pinterest OAuth flow |
| GET | `/auth/pinterest/callback` | No | Pinterest OAuth callback |
| POST | `/api/pinterest/complete` | Handoff code | Complete OAuth handoff → bearer token |
| GET | `/api/pinterest/status` | Bearer | Check Pinterest connection status |
| POST | `/api/pinterest/disconnect` | Bearer | Disable local Agent credential; provider-side revocation is not performed |
| GET | `/api/pinterest/account` | Bearer | Get Pinterest account info |
| GET | `/api/pinterest/boards` | Bearer | List authenticated user's boards |
| POST | `/api/pinterest/boards` | Bearer + `Idempotency-Key` | Create a board through the Agent durable idempotency ledger |
| POST | `/api/pinterest/pins` | Bearer | Create a new pin |

### TikTok

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/tiktok/auth` | No | Start TikTok OAuth flow |
| GET | `/tiktok/auth/callback` | No | TikTok OAuth callback |
| POST | `/api/tiktok/complete` | Handoff code | Complete OAuth handoff → session |
| GET | `/api/tiktok/status` | Cookie | Check TikTok connection status |
| GET | `/api/tiktok/creator-info` | Cookie | Get TikTok creator information |
| POST | `/api/tiktok/disconnect` | Cookie | Revoke TikTok and clear tokens |
| POST | `/api/tiktok/post/init` | Cookie | Initialize Direct Post video upload |
| POST | `/api/tiktok/post/upload` | Cookie | Upload video to TikTok |
| GET | `/api/tiktok/post/status/:publish_id` | Cookie | Check post processing status |

### YouTube

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/youtube/auth` | No | Start YouTube OAuth flow |
| GET | `/youtube/auth/callback` | No | YouTube OAuth callback |
| POST | `/api/youtube/complete` | Handoff code | Complete OAuth handoff → bearer token |
| GET | `/api/youtube/status` | Bearer | Check YouTube connection status |
| GET | `/api/youtube/channel` | Bearer | Get authenticated channel info |
| POST | `/api/youtube/upload` | Bearer | Upload video to YouTube (multipart) |
| GET | `/api/youtube/video-status/:videoId` | Bearer | Check video processing status |
| POST | `/api/youtube/disconnect` | Bearer | Disconnect YouTube and clear tokens |

### Model 2 board and OAuth safety contract

- `POST /api/pinterest/boards` requires an `Idempotency-Key` header (8–200 characters). The Hub retains the same key for a pending request and the same request payload across retries.
- A successful replay returns `replayed: true`. A `409` with `outcome_unknown: true` means the Agent is blocking duplicate provider writes; do not create a new operation or automatically retry with a different key. Reconcile the existing operation first.
- An ambiguous OAuth refresh is not replayed. HTTP 5xx and transport/timeout failures from the refresh request are also surfaced as uncertain; failures from the original account operation are not mislabeled as refresh outcomes, and definitive pre-provider/4xx refresh errors remain distinct. `GET /api/pinterest/status` reports `refresh_outcome_uncertain: true` and directs the user not to retry refresh until reconciliation. Ordinary Agent 5xx/transport failures without an attempted refresh return `agent_unavailable: true` and do not clear the saved Hub session or prompt a new OAuth consent flow.
- Pinterest disconnect disables the local Agent credential only. The response explicitly includes `provider_token_revoked: false`; users must revoke the app's provider-side authorization separately if they require it.

## Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request — missing or invalid parameters |
| 401 | Unauthorized — no valid session/token |
| 403 | Forbidden — insufficient permissions |
| 404 | Not Found |
| 429 | Rate Limited by upstream API |
| 500 | Internal Server Error |

## Security

- All OAuth client secrets remain server-side only
- Access/refresh tokens are never exposed to the frontend
- One-time handoff codes are single-use with 5-minute TTL
- Bearer session tokens are opaque random hex strings (24-hour TTL)
- CORS is restricted to the authorized frontend origin
- OAuth state parameter validates CSRF protection
- HTTPS required in production
