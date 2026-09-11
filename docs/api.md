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
| POST | `/api/pinterest/disconnect` | Bearer | Revoke Pinterest and clear tokens |
| GET | `/api/pinterest/account` | Bearer | Get Pinterest account info |
| GET | `/api/pinterest/boards` | Bearer | List authenticated user's boards |
| POST | `/api/pinterest/boards` | Bearer | Create a new board |
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
