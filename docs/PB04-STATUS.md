# PB-04 — Modern Living Hub → Pinterest Agent credential custody

**Status: merged and deployed; live OAuth credential handoff still requires a human Pinterest login/consent.** Updated 2026-10-27.

## Release and CI

- Hub PR #6: https://github.com/shehrozali6465372-ctrl/modern-living-hub/pull/6 — merged to `main` as `42b8b50f666e63c207f34b769cef32da022f2239`.
- Hub credential-security workflow on that exact main SHA: **PASS** — `npm ci`, `npm audit --audit-level=moderate`, both Node syntax checks, mocked OAuth handoff integration test, and credential-custody assertions.
- Render service `modern-living-hub`, URL `https://modern-living-hub.onrender.com`, deploy `dep-dbg5rno473hc73fdo380`: **live** at SHA `42b8b50f666e63c207f34b769cef32da022f2239`.
- The publicly served Vercel homepage and `/pinterest.html` both return HTTP 200. The live Pinterest page's configured backend URL points to `https://modern-living-hub.onrender.com`.

## Production checks

- `GET /api/health` on the Render backend returned HTTP 200 and reported `agent_configured`, `pinterest_client_id_configured`, and `redirect_uri_configured` as true.
- `GET /auth/pinterest` returned HTTP 302 to Pinterest OAuth with state/session cookies. The diagnostic request was stopped at the redirect; it did not authorize an account or obtain/print tokens.
- Unauthenticated `GET /api/pinterest/boards` returned HTTP 401, expected when the browser has no Hub session token.
- Read-only Neon check at verification time showed one connected Agent credential, one confirmed published Pin, and zero analytics snapshots. This does not prove a new Hub OAuth authorization has completed or that the Hub-to-Agent handoff is production-closed.

## Security and implementation

- The Hub callback exchanges the OAuth authorization code, reads Pinterest user identity, and sends credentials server-to-server to the Agent using `X-Credential-Ingest-Key`.
- It waits for Agent `/health`, maps Pinterest user ID to `pinterest:<user_id>`, passes access/refresh expiry metadata, and requires the Agent response `stored === true` before returning a connected handoff.
- The mocked `server/test-pinterest-agent-handoff.mjs` covers identity mapping, expiry metadata, token non-disclosure, one-time handoff, account lookup, and fail-closed storage. It does **not** prove that a real OAuth callback has persisted a fresh credential into production Neon.
- The package lockfile is complete; the workflow uses reproducible `npm ci`. The checked dependency set passed npm's moderate-severity audit with zero reported vulnerabilities.

## Remaining verification gates

1. A human must open **https://modern-living-hub.onrender.com/auth/pinterest**, sign in to Pinterest, and consent to the requested scopes. After the redirect returns to the Hub page, verify the browser reports connected and confirm Agent storage/account lookup plus the Neon credential metadata. Do not paste OAuth codes or tokens into chat.
2. Verify the Hub's configured `PINTEREST_AGENT_INGEST_KEY` matches the Agent's credential-ingest key indirectly through a successful OAuth handoff; do not print either secret.
3. A live analytics snapshot remains unverified until the Agent's protected `/learning-loop/run` is invoked with authorized local API-key access and eligible metrics are persisted.

Vercel direct deployment metadata inspection requested team authorization; its public frontend routes are reachable. Consent link provided separately. No new Pin or board was created by these checks, and no token or secret value is stored in this report.
