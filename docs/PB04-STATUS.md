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


## Model 1 scope boundary — 2026-11-05

- User decision: defer Pinterest ads:read, advertiser accounts, and Audience Insights to Model 2. Do not request ads:read during Model 1 OAuth, trigger reconnect/consent, generate developer test tokens, or reset app credentials.
- Hub local OAuth scope list is limited to boards:read, boards:write, pins:read, pins:write, and user_accounts:read. Pinterest's actual returned scope remains the source of truth and is persisted without inference.
- Model 1 UI retains organic engagement analytics only; advertiser and audience controls/routes are not exposed in the Hub. Ads:read remains deferred to Model 2.
- Local Hub tests and JS syntax checks pass; Agent suite passes 106 tests, 5 skipped. Changes remain local/uncommitted; no push, merge, deployment, OAuth reconnect, token refresh, DB write, Pin, or board creation occurred.
- This scope boundary does not alter PB-04's prior credential-custody closure; it records the user's product-scope decision for Model 1.


## Model 1 publishing gateway audit — 2026-11-05

- Critical gap: Hub POST /api/pinterest/pins currently calls Agent POST /integrations/pinterest/operation with operation=create_pin. Agent's generic operation allowlist maps that operation directly to Pinterest POST /pins without publication-ledger reservation or idempotency protection.
- Agent controlled routes /workflow/publish-product and /products/{product_id}/content/{content_version_id}/publish use publication-ledger begin/finish operations; Hub's manual Pin form does not currently use them.
- Keep the manual UI behavior intact until a ledger-backed Hub-to-Agent gateway replaces it. Do not invoke the bypass route or publish a real Pin in tests. Treat this as a critical Model 1 release blocker; remove generic create_pin only after the replacement gateway and regression tests are complete.
- Audit was read-only. No Pin/board creation, provider write, production DB mutation, or deployment occurred.

## 2026-11-05 — Manual Pin gateway local implementation
- Replaced Hub's direct generic create_pin call with Agent POST /integrations/pinterest/publish-manual, forwarding a required idempotency key server-to-server.
- Browser keeps the same key for identical retry payloads and clears it only after confirmed success.
- Agent now persists a manual product/content-version draft, binds an idempotency fingerprint, verifies the connected account and selected board, reserves pin_publications, and records the confirmed Pinterest Pin ID.
- Unknown/pending outcomes are blocked from blind retry; the generic Agent operation no longer allows create_pin.
- Verification so far: mock-only Agent gateway tests 4/4; full Agent suite 110 passed, 5 skipped; Hub server suite passed; no live Pinterest write or deployment.
- Migration 011_manual_publish_idempotency_fingerprint.sql is local only and must be applied to the correct Neon database during an approved deployment. Production is not yet verified.
- Final post-pagination verification: Agent full suite 112 passed, 5 skipped; focused manual gateway 6 passed; Hub server suite passed; Node syntax checks and git diff --check passed. Existing Starlette/httpx TestClient deprecation warning remains.


## 2026-11-05 — Manual Pin gateway contract regression
- Extended the mocked Hub-to-Agent integration test: unauthenticated `/api/pinterest/pins` is rejected; authenticated requests forward account ID, Pin payload, service credential boundary, and the exact `Idempotency-Key` to `/integrations/pinterest/publish-manual`. The Agent response is mapped back to the Hub response.
- `npm test --prefix server` passes, including OAuth/Agent handoff and Pinterest analytics UI tests. `node --check server/src/server.js`, `node --check assets/js/pinterest.js`, and `git diff --check` pass. All upstreams are mocked; no real Pinterest Pin was published.
- Agent-side follow-up: 8 manual gateway tests pass; full suite 114 passed, 5 skipped. Vault failures return sanitized 503 before network/ledger activity; image validation occurs before ledger reservation.
- Production remains blocked pending review and explicit authorization to apply migration 011 and deploy.


## 2026-11-05 — Agent database and identity review
- Agent review added a strict identity consistency check between the encrypted credential's stored Pinterest user ID, the live `/user_account.id`, and the `pinterest:<user_id>` account key. Mismatch fails closed before board lookup, draft persistence, ledger reservation, or Pin creation.
- Board pagination safety now reports incomplete verification (HTTP 503) when the safe scan limit is reached.
- Hub-to-Agent handoff contract tests remain passing. Agent full suite: 115 passed, 5 skipped. PostgreSQL integration tests were skipped because isolated test database URLs are not configured; live DB compatibility is not claimed.
- Migration 011 remains local and unapplied. No production deploy or Pinterest write was performed.

## 2026-11-05 — Cross-repository integration review follow-up
- Found and fixed Hub CORS omission: browser manual Pin requests include `Idempotency-Key`, and the preflight allowlist now explicitly permits it. Added an OPTIONS regression test against the exact configured frontend origin.
- Replaced the Hub's fixed 15-second Agent fetch timeout with a bounded configurable timeout (100 ms–300 s; default `PINTEREST_AGENT_REQUEST_TIMEOUT_MS=90000`) and explicit route budgets: manual publish 180 s, organic analytics 240 s, advertiser listing 60 s, trends/featured topics 60 s, audience insights 90 s. These are upper bounds, not claims that provider operations always complete within them.
- Hub mocked integration test captures and asserts the outgoing timeout budgets and CORS preflight. `node --check` for server and test passes; `npm test` passes (OAuth/Agent handoff and analytics UI suites). No live Pinterest call or Pin publish was made.
- Ads read remains deferred to Model 2 per user decision; no ads:read scope was added or requested. Model 1 HTML exposes organic engagement only; legacy advertiser/audience server handlers and unused JS helpers remain in code but are not surfaced by the Model 1 UI.
- Working tree only; no commit, push, PR, merge, or deployment.


## 2026-11-05 — Final local integration verification refresh
- Fresh Hub server suite npm test passed: mocked OAuth/Agent handoff and analytics UI regression. node --check passed for server and handoff test. Agent full suite against isolated Neon test branch passed 146 tests with one PB-10 backend-termination skip.
- Manual Pin path requires Hub session authentication, forwards Idempotency-Key through CORS, and calls Agent /integrations/pinterest/publish-manual. Agent validates stored account identity and board ownership, persists draft/idempotency fingerprint, then uses the unified publication gateway. The generic operation create_pin bypass is removed.
- OAuth scope request remains limited to boards:read, boards:write, pins:read, pins:write, user_accounts:read. Pinterest-returned scope is persisted without inference; ads:read remains deferred to Model 2. No OAuth reconnect/refresh or real Pin/Board write was performed.
- Changes remain local/uncommitted. No exact-current-code CI result, push, PR, merge, or deployment. Agent production schema still lacks migrations 011/012; explicit release approval and production compatibility verification are required.

## 2026-11-05 — Hub feature branch reconciled with current main
- User approved treating current `main` as authoritative for the legacy Product Tag UI/API. The branch no longer reintroduces Existing Pins/Product Tag UI or product-tag routes; those are intentionally omitted.
- Reconciled the feature branch with latest `main`, retaining its affiliate scheduler UI/backend and canonical `/workflow/publish-hub-pin` gateway. Organic engagement analytics and read-only Trends/Featured Topics UI and proxy routes were ported on top of that current base.
- Hub Agent request timeout is configurable and bounded (default 90 s, maximum 300 s); explicit budgets are 180 s for manual publish, 240 s for organic analytics, and 60 s for Trends/Featured Topics. CORS explicitly allows `Idempotency-Key`.
- Removed Model 2 advertiser/audience routes and UI from the active Hub implementation. OAuth scope remains unchanged; no ads:read consent or reconnect was initiated.
- Verification after reconciliation: `npm test` PASS (mocked OAuth/Agent handoff and static analytics/trends contract); Node syntax checks PASS; `git diff --check` PASS; fresh `npm audit --audit-level=moderate` reports 0 vulnerabilities. No live Pinterest provider calls, Pin/Board creation, OAuth refresh, or production deployment occurred.
- This reconciliation is on the Hub feature branch only. PR remains draft and is not merged to `main`; no Pages deployment was triggered.


## 2026-11-11 — Model 2 Agent contract integration hardening (local branch)

- Current Agent feature head `6f9560d3cdf06f96e40e8cde7c0148edb7e384f4` requires `Idempotency-Key` for `create_board`, returns `replayed: true` for a completed duplicate, and returns `409` for uncertain/in-progress operations. The Hub's prior `main` code did not forward a board key.
- Hub branch `fix/model2-board-idempotency-contract` now requires and forwards the key, exposes replay metadata, preserves the same browser-side key for an identical pending payload, blocks a different board request while the previous one is unresolved, and does not automatically retry uncertain outcomes.
- The Hub now surfaces Model 2 OAuth-refresh uncertainty for uncertain `409`, HTTP 5xx and transport/timeout failures (without replaying refresh); definitive 4xx responses remain distinct. It explicitly reports `provider_token_revoked: false` on local-only disconnect.
- Mocked Hub-to-Agent integration tests cover missing key rejection, key forwarding, replay response, uncertain `409` without retry, key preservation across a preflight `401` refresh, refresh uncertainty, and local-only disconnect semantics.
- `npm test` passes, including the new Model 2 static UI contract suite. All upstream calls in the Hub tests are mocked; no real Pinterest Board or Pin was created, no OAuth token was refreshed, and no production database or deployment was touched.
- Changes remain local and uncommitted on a dedicated Hub feature branch. PR, merge, and deployment are not yet performed.
