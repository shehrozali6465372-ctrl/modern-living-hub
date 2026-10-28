# PB-04 — Modern Living Hub → Pinterest Agent credential custody

**Status: CLOSED — live OAuth handoff and encrypted Neon persistence verified.** Updated 2026-10-28.

## Release and CI

- Hub PR #6: https://github.com/shehrozali6465372-ctrl/modern-living-hub/pull/6 — merged to `main` as `42b8b50f666e63c207f34b769cef32da022f2239`.
- Hub credential-security workflow on that exact main SHA: **PASS** — `npm ci`, `npm audit --audit-level=moderate`, Node syntax checks, mocked OAuth handoff integration test, and credential-custody assertions.
- Render service `modern-living-hub` at `https://modern-living-hub.onrender.com`; prior deployment verification recorded it live at SHA `42b8b50f666e63c207f34b769cef32da022f2239`.
- Public Vercel homepage and `/pinterest.html` returned HTTP 200 in prior checks; the Pinterest page backend points to the Hub Render service.

## Live production verification — 2026-10-28

- Agent Render logs recorded `POST /integrations/pinterest/credentials` → **201 Created** at `2026-10-28T09:26:42.358Z`.
- The subsequent Agent `POST /integrations/pinterest/operation` requests returned **200 OK**.
- User ran a read-only Neon query against `pinterest_affiliate.public.pinterest_credentials`. The returned row showed:
  - `account_id`: `pinterest:1069323642682526567`
  - `status`: `connected`
  - `updated_at`: `2026-10-28 09:26:42.345183+00`
  - access-token ciphertext length: `129` bytes
  - refresh-token ciphertext length: `567` bytes
- Neon update timestamp matches the Agent credential-ingest event to within milliseconds. Together, the production ingest response, successful account operations, and fresh Neon row metadata verify the real OAuth handoff and encrypted credential persistence.
- No plaintext access or refresh token was selected, displayed, or stored in this report. No Pin or board was created by these verification steps.

## Security and implementation

- Hub callback exchanges the OAuth authorization code, reads Pinterest user identity, and sends credentials server-to-server to the Agent using `X-Credential-Ingest-Key`.
- The Hub waits for Agent `/health`, maps Pinterest user ID to `pinterest:<user_id>`, passes expiry metadata, and requires the Agent response `stored === true` before returning a connected handoff.
- Automated tests cover identity mapping, expiry metadata, token non-disclosure, one-time handoff, account lookup, and fail-closed storage. The live production checks above supplement the mocked tests.

## Closure

**PB-04 is closed.** Human consent, live Agent credential ingestion, successful Agent operations, and corresponding encrypted Neon persistence have all been verified. Analytics snapshot/learning-loop status is tracked separately and is not a PB-04 closure requirement.
