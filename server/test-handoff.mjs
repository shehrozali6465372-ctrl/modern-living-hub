/**
 * End-to-end handoff flow test.
 *
 * Tests the complete cross-site OAuth handoff architecture.
 * Uses a dedicated test server with a /test/inject endpoint for injecting tokens.
 */

process.env.PINTEREST_CLIENT_ID = "test_client_id";
process.env.PINTEREST_CLIENT_SECRET = "test_secret_value";
process.env.PINTEREST_REDIRECT_URI = "https://modern-living-hub.onrender.com/auth/pinterest/callback";
process.env.SESSION_SECRET = "test_session_key_for_cookies_1234567890abcdef";
process.env.FRONTEND_URL = "https://shehrozali6465372-ctrl.github.io/modern-living-hub";
process.env.NODE_ENV = "test";
process.env.PORT = "3470";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const BASE = "http://localhost:3472";

await import("./src/server.js");
await new Promise(r => setTimeout(r, 500));

// ─── Inject test tokens via the real callback flow ───
// We can't mock fetch in Node.js 22 easily, so we test the handoff mechanism
// by injecting tokens via the server's own endpoints.

// Helper: extract cookies
function extractCookies(sc) {
  if (!sc) return {};
  const c = {};
  for (const p of sc.split(/,(?=[^;]*=)/)) {
    const t = p.trim();
    const i = t.indexOf("=");
    if (i > 0) c[t.slice(0, i)] = t.slice(i + 1).split(";")[0];
  }
  return c;
}

const TS = {}; // shared test state

describe("Handoff mechanism — direct tests", () => {

  it("1. /api/pinterest/complete rejects missing handoff", async () => {
    const r = await fetch(BASE + "/api/pinterest/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(r.status, 400);
    const d = await r.json();
    assert.ok(d.error.includes("Missing"));
    console.log("  → ✓ Missing handoff rejected");
  });

  it("2. /api/pinterest/complete rejects invalid handoff", async () => {
    const r = await fetch(BASE + "/api/pinterest/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handoff: "invalid_code_12345" })
    });
    assert.equal(r.status, 400);
    const d = await r.json();
    assert.ok(d.error.includes("Invalid") || d.error.includes("expired"));
    console.log("  → ✓ Invalid handoff rejected");
  });

  it("3. OAuth callback creates handoff with correct state (mocked token exchange via test fetch override)", async () => {
    // Override globalThis.fetch to intercept ONLY the Pinterest token call
    const _origFetch = globalThis.fetch;
    let fetchCalls = [];

    globalThis.fetch = function (url, opts) {
      fetchCalls.push({ url: typeof url === "string" ? url : String(url), opts });
      if (typeof url === "string" && url.includes("api.pinterest.com/v5/oauth/token")) {
        return Promise.resolve(new Response(JSON.stringify({
          access_token: "test_pinterest_token_from_mock",
          refresh_token: "test_refresh_token_from_mock",
          token_type: "bearer",
          scope: "boards:read boards:write pins:read pins:write"
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }));
      }
      return _origFetch(url, opts);
    };

    try {
      // Step 1: Start OAuth
      const r1 = await fetch(BASE + "/auth/pinterest", { redirect: "manual" });
      const loc = r1.headers.get("location");
      const state = new URL(loc).searchParams.get("state");
      const cookies = extractCookies(r1.headers.get("set-cookie"));
      assert.ok(cookies["mlh.sid"], "mlh.sid should be set");
      assert.ok(state, "State should be present");

      // Step 2: Callback with correct state (token exchange is mocked)
      const cookieStr = `mlh.sid=${cookies["mlh.sid"]}; mlh.sid.sig=${cookies["mlh.sid.sig"]}`;
      const r2 = await fetch(
        BASE + "/auth/pinterest/callback?code=test_code&state=" + encodeURIComponent(state),
        { redirect: "manual", headers: { Cookie: cookieStr } }
      );

      assert.equal(r2.status, 302);
      const redirectUrl = r2.headers.get("location");

      // Verify handoff is in the redirect
      assert.ok(redirectUrl.includes("pinterest_connected=1"), "Should have pinterest_connected=1");
      assert.ok(redirectUrl.includes("handoff="), "Should have handoff");

      // Verify NO Pinterest tokens in the URL
      assert.ok(!redirectUrl.includes("access_token"), "NO access_token in URL");
      assert.ok(!redirectUrl.includes("refresh_token"), "NO refresh_token in URL");
      assert.ok(!redirectUrl.includes("test_pinterest"), "NO token value in URL");

      // Extract handoff code
      const handoffCode = new URL(redirectUrl).searchParams.get("handoff");
      assert.ok(handoffCode, "Handoff code present");
      assert.ok(handoffCode.length >= 32, "Handoff code long enough");
      assert.ok(/^[a-f0-9]+$/.test(handoffCode), "Handoff code is hex");

      TS.handoffCode = handoffCode;
      console.log("  → Handoff:", handoffCode.slice(0, 16) + "...");
      console.log("  → Redirect:", redirectUrl.slice(0, 80) + "...");
      console.log("  → Fetch calls:", fetchCalls.length);
      console.log("  → ✓ Handoff created, no tokens in URL");
    } finally {
      globalThis.fetch = _origFetch;
    }
  });

  it("4. POST /api/pinterest/complete with valid handoff → session token", async () => {
    const r = await fetch(BASE + "/api/pinterest/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handoff: TS.handoffCode })
    });

    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.connected, true);
    assert.ok(d.session_token, "Should have session_token");
    assert.ok(/^[a-f0-9]{64}$/.test(d.session_token), "Session token is 64-char hex");

    // Verify NO Pinterest tokens in response
    const s = JSON.stringify(d);
    assert.ok(!s.includes("access_token"), "NO access_token in response");
    assert.ok(!s.includes("test_pinterest"), "NO token value in response");

    TS.sessionToken = d.session_token;
    console.log("  → Session token:", d.session_token.slice(0, 16) + "...");
    console.log("  → ✓ Bearer token received, no Pinterest tokens leaked");
  });

  it("5. GET /api/pinterest/status with Bearer → connected:true", async () => {
    const r = await fetch(BASE + "/api/pinterest/status", {
      headers: { "Authorization": "Bearer " + TS.sessionToken }
    });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.connected, true);
    assert.ok(d.connected_at);

    // Verify NO tokens in response
    assert.ok(!JSON.stringify(d).includes("access_token"));
    assert.ok(!JSON.stringify(d).includes("test_pinterest"));

    console.log("  → Status: connected=true");
    console.log("  → ✓ Bearer auth works");
  });

  it("6. Handoff code cannot be reused (single-use)", async () => {
    const r = await fetch(BASE + "/api/pinterest/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handoff: TS.handoffCode })
    });
    assert.equal(r.status, 400);
    const d = await r.json();
    assert.ok(d.error);
    console.log("  → Reuse:", r.status, d.error);
    console.log("  → ✓ Single-use enforced");
  });

  it("7. Bearer token works for boards endpoint", async () => {
    const r = await fetch(BASE + "/api/pinterest/boards", {
      headers: { "Authorization": "Bearer " + TS.sessionToken }
    });
    const d = await r.json();
    assert.notEqual(d.error, "Not connected to Pinterest.",
      "Bearer token should be accepted");
    console.log("  → Boards:", r.status, d.error || "API called");
    console.log("  → ✓ Bearer accepted");
  });

  it("8. Bearer token works for pins endpoint", async () => {
    const r = await fetch(BASE + "/api/pinterest/pins", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + TS.sessionToken
      },
      body: JSON.stringify({
        board_id: "123", title: "Test",
        image_url: "https://x.com/i.jpg", destination_url: "https://x.com"
      })
    });
    const d = await r.json();
    assert.notEqual(d.error, "Not connected to Pinterest.",
      "Bearer token should be accepted");
    console.log("  → Pins:", r.status, d.error || "API called");
    console.log("  → ✓ Bearer accepted");
  });

  it("9. Disconnect invalidates session token", async () => {
    const r1 = await fetch(BASE + "/api/pinterest/disconnect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + TS.sessionToken
      }
    });
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).disconnected, true);

    const r2 = await fetch(BASE + "/api/pinterest/status", {
      headers: { "Authorization": "Bearer " + TS.sessionToken }
    });
    assert.equal((await r2.json()).connected, false);
    console.log("  → After disconnect: connected=false");
    console.log("  → ✓ Session invalidated");
  });

  it("10. Unauthenticated status → connected:false", async () => {
    const r = await fetch(BASE + "/api/pinterest/status");
    assert.equal((await r.json()).connected, false);
    console.log("  → ✓ No auth → false");
  });

  it("11. Invalid bearer → connected:false", async () => {
    const r = await fetch(BASE + "/api/pinterest/status", {
      headers: { "Authorization": "Bearer invalid_token_xyz" }
    });
    assert.equal((await r.json()).connected, false);
    console.log("  → ✓ Invalid bearer → false");
  });

  it("12. CORS allows Authorization header", async () => {
    const r = await fetch(BASE + "/api/pinterest/status", {
      method: "OPTIONS",
      headers: {
        "Origin": "https://shehrozali6465372-ctrl.github.io",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization, Content-Type"
      }
    });
    assert.ok(r.headers.get("access-control-allow-headers")?.includes("Authorization"));
    console.log("  → ✓ CORS allows Authorization");
  });

  it("13. No secrets in redirect URL (Pinterest error case)", async () => {
    // Test with failed token exchange — redirect should have error, no tokens
    const r1 = await fetch(BASE + "/auth/pinterest", { redirect: "manual" });
    const state = new URL(r1.headers.get("location")).searchParams.get("state");
    const cookies = extractCookies(r1.headers.get("set-cookie"));

    const r2 = await fetch(
      BASE + "/auth/pinterest/callback?code=expired&state=" + encodeURIComponent(state),
      { redirect: "manual", headers: { Cookie: `mlh.sid=${cookies["mlh.sid"]}; mlh.sid.sig=${cookies["mlh.sid.sig"]}` } }
    );

    const url = r2.headers.get("location");
    assert.ok(url.includes("pinterest_error="), "Should have error");
    assert.ok(!url.includes("access_token"), "No access_token");
    assert.ok(!url.includes("test_secret"), "No client secret");
    console.log("  → ✓ No secrets in error redirect");
  });
});

console.log("\n✅ Handoff tests complete.\n");
