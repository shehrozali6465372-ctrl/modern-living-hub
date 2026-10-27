# PB-04 — Modern Living Hub → Pinterest Agent credential custody

**Status: local code/test changes PASS; not pushed or deployed.** Updated 2026-10-27.

## Verified locally

- Current Hub callback exchanges an OAuth authorization code, reads the Pinterest user identity, then sends the credentials server-to-server to the Pinterest Agent using `X-Credential-Ingest-Key`.
- Hub waits for Agent `/health`, maps Pinterest user ID to `pinterest:<user_id>`, passes access/refresh token expiry metadata, and requires the Agent response `stored === true` before returning a connected handoff.
- New `server/test-pinterest-agent-handoff.mjs` mocks the Pinterest token endpoint, Pinterest user lookup, Agent health, Agent credential ingest and account lookup. It verifies identity mapping, expiry timestamps, no Pinterest token in redirect/response, one-time handoff, successful account lookup, and fail-closed behavior when the Agent refuses credential storage.
- `node --check server/src/server.js` and `node --check server/test-pinterest-agent-handoff.mjs`: PASS.
- `npm ci`: PASS after repairing missing `pg` entries in the lockfile.
- Upgraded Multer to a supported 2.x line and compatible dependencies. `npm audit`: 0 vulnerabilities.
- `.github/workflows/pinterest-credential-security.yml` now uses `npm ci` and runs the new mocked integration test before the static credential-custody assertions.

## Limits / release gates

- This test is mocked: it does not exercise a real Pinterest authorization, the real production Agent secret agreement, or actual Neon insertion. No OAuth flow was started and no token was read from production.
- The changes are committed locally on branch `local/pb04-candidate`, HEAD `a93d02c279a25cfc03c85bddd0ae193def9a4578`. The working tree is clean; this commit is not pushed to GitHub.
- GitHub CLI is not authenticated on the test device, and a GitHub connector branch write was previously blocked by safety controls. No remote repository update was attempted through an alternate/bypass route.
- After the changes are published through an approved GitHub PR/release path, wait for CI on the exact commit, deploy Hub/Agent through the existing release path, and complete a fresh OAuth authorization in the browser. Verify the Agent confirms encrypted Neon storage and a read-only account lookup before treating PB-04 as production-closed.

No credentials, token values, or ingest secrets are stored in this report.
