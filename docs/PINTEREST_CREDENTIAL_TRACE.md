# Pinterest credential custody trace

## Finding

The pre-UCOS-handoff Modern Living Hub implementation initialized a PostgreSQL-backed `pinterest_credentials` table from `DATABASE_URL`. It encrypted access and refresh tokens with AES-256-GCM using `PINTEREST_TOKEN_ENCRYPTION_KEY`. That was a separate credential-storage path from the canonical UCOS Layer 13 credential vault.

On 2026-10-07, commit `e46b5167ab7beb90ef3a7df8f51b3c2a0d41c7ab` moved the OAuth callback to the UCOS credential API. Subsequent commit `e299de5711376394a10c80f9c92e926d1ec47b57` removed the obsolete Modern Living Hub credential-store module. No data-migration step from the old `pinterest_credentials` table into UCOS L13 is evidenced in those changes.

Therefore, an authorization completed before the handoff change must not be assumed to exist in UCOS. Repository history establishes the old storage mechanism, but available Render logs do not prove whether a specific old authorization row exists or which database the old `DATABASE_URL` pointed to at that moment. No token values were inspected or copied during this trace.

## New authorization path

Current OAuth callback flow:
1. Exchange the OAuth code with Pinterest.
2. Fetch the Pinterest user identity.
3. Match it to an enabled canonical UCOS Pinterest account whose `platform_account_id` or `external_account_id` equals the real Pinterest user ID. An optional `UCOS_PINTEREST_ACCOUNT_ID` can select the intended registered account, but does not bypass the identity check.
4. Send the credential to UCOS `POST /credentials/pinterest`.
5. Require UCOS to explicitly confirm `data.stored === true`; otherwise, fail the OAuth callback rather than reporting success.

The Modern Living Hub backend now logs non-secret progress markers for identity validation, canonical account matching, and UCOS vault persistence. It must never log access tokens, refresh tokens, client secrets, or authorization codes.

## Verification status

- Code update `f8b776ffe8c7406c11ab43b60e2852a83270d6f9` is deployed to Render.
- Pinterest credential security CI passed for the code update and the follow-up configuration documentation commit.
- Follow-up deployment for commit `35bf7400030895d716f217c04ab4c4cdbb4e70f2` is live.
- The actual prior database row and current UCOS account-to-Pinterest-ID mapping were not readable through the available log access. Do not disconnect/re-authorize until the canonical account mapping and UCOS vault configuration are confirmed.
- After re-authorization, confirm a successful callback and UCOS storage marker, then verify account status/boards through UCOS before publishing a real Pin.
