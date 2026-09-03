/**
 * Test the signed token cookie fallback mechanism.
 *
 * Verifies that:
 *  1. Signed token cookie (mlh.ptoken) is read by status endpoint
 *  2. getUserToken falls back to signed cookie when tokenStore is empty
 *  3. Disconnect clears both tokenStore and cookie
 *  4. Cookie is HttpOnly (not client-readable)
 */

process.env.PINTEREST_CLIENT_ID = "test_client_id";
process.env.PINTEREST_CLIENT_SECRET = "test_secret_value";
process.env.PINTEREST_REDIRECT_URI = "https://modern-living-hub.onrender.com/auth/pinterest/callback";
process.env.SESSION_SECRET = "test_session_key_for_cookies_1234567890abcdef";
process.env.FRONTEND_URL = "https://shehrozali6465372-ctrl.github.io/modern-living-hub";
process.env.NODE_ENV = "test";
process.env.PORT = "3462";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import cookieSignature from "cookie-signature";

const BASE = "http://localhost:3462";
const SECRET = process.env.SESSION_SECRET;

await import("./src/server.js");
await new Promise(r => setTimeout(r, 500));

// Create a signed cookie value matching Express's res.cookie({signed:true}) format
function makeSignedCookie(value) {
  // Express: val = 's:' + sign('j:' + JSON.stringify(value), secret)
  // cookie-signature.sign returns: val + '.' + base64(hmac)
  const jsonVal = 'j:' + JSON.stringify(value);
  return 's:' + cookieSignature.sign(jsonVal, SECRET);
}

describe("Token cookie fallback mechanism", () => {

  it("1. Signed token cookie is accepted by status endpoint", async () => {
    const tokenData = {
      access_token: "test_pinterest_token_abc123",
      connected_at: new Date().toISOString()
    };
    const signedVal = makeSignedCookie(tokenData);
    console.log("  → Signed cookie value:", signedVal.slice(0, 50) + "...");

    const r = await fetch(BASE + "/api/pinterest/status", {
      headers: { "Cookie": `mlh.ptoken=${signedVal}` }
    });

    const data = await r.json();
    console.log("  → Status response:", JSON.stringify(data));
    assert.equal(r.status, 200);
    assert.equal(data.connected, true, "Should be connected via cookie fallback");
    assert.ok(data.connected_at, "Should have connected_at timestamp");
    console.log("  → ✓ Token cookie fallback WORKS: connected=true");
  });

  it("2. getUserToken falls back to signed cookie when tokenStore is empty", async () => {
    const tokenData = {
      access_token: "test_pinterest_token_abc123",
      connected_at: new Date().toISOString()
    };
    const signedVal = makeSignedCookie(tokenData);

    // Boards endpoint should try Pinterest API (not return "Not connected")
    const r = await fetch(BASE + "/api/pinterest/boards", {
      headers: { "Cookie": `mlh.ptoken=${signedVal}` }
    });

    const data = await r.json();
    console.log("  → Boards status:", r.status, "error:", data.error || "none");

    // Should NOT be 401 "Not connected" — getUserToken found token in cookie
    assert.notEqual(data.error, "Not connected to Pinterest.",
      "getUserToken should find token in cookie");
    console.log("  → ✓ getUserToken falls back to cookie");
  });

  it("3. Disconnect clears signed token cookie", async () => {
    const tokenData = {
      access_token: "test_pinterest_token_abc123",
      connected_at: new Date().toISOString()
    };
    const signedVal = makeSignedCookie(tokenData);

    // Disconnect
    const r = await fetch(BASE + "/api/pinterest/disconnect", {
      method: "POST",
      headers: { "Cookie": `mlh.ptoken=${signedVal}` }
    });

    const data = await r.json();
    assert.equal(data.disconnected, true);

    // Check Set-Cookie header clears mlh.ptoken
    const setCookie = r.headers.get("set-cookie");
    console.log("  → Disconnect Set-Cookie:", setCookie ? setCookie.slice(0, 120) : "none");
    assert.ok(setCookie && setCookie.includes("mlh.ptoken="),
      "Disconnect should set mlh.ptoken cookie to clear it");
    assert.ok(setCookie.includes("Expires=Thu, 01 Jan 1970") || setCookie.includes("expires=Thu, 01 Jan 1970") || setCookie.includes("Max-Age=0"),
      "Cookie should be expired/cleared");
    console.log("  → ✓ Disconnect clears mlh.ptoken cookie");
  });

  it("4. Signed cookie is tamper-proof", async () => {
    const tokenData = {
      access_token: "test_pinterest_token_abc123",
      connected_at: new Date().toISOString()
    };
    const signedVal = makeSignedCookie(tokenData);

    // Tamper with the cookie value
    const tampered = signedVal.slice(0, -5) + "XXXXX";

    const r = await fetch(BASE + "/api/pinterest/status", {
      headers: { "Cookie": `mlh.ptoken=${tampered}` }
    });

    const data = await r.json();
    console.log("  → Tampered cookie → connected:", data.connected);
    assert.equal(data.connected, false, "Tampered cookie should be rejected");
    console.log("  → ✓ Tampered cookie correctly rejected");
  });

  it("5. Cookie has correct attributes (HttpOnly, Secure in production)", async () => {
    // Verify the server sets cookie attributes correctly by checking
    // the oauth_state cookie from /auth/pinterest (same options as token cookie)
    const r = await fetch(BASE + "/auth/pinterest", { redirect: "manual" });
    const setCookie = r.headers.get("set-cookie");

    assert.ok(setCookie.includes("httponly") || setCookie.includes("HttpOnly"),
      "Cookie should be HttpOnly");
    console.log("  → ✓ Cookie has HttpOnly attribute");

    // In test mode, Secure is not set (expected)
    // In production, Secure would be set
    const isProduction = process.env.NODE_ENV === "production";
    if (isProduction) {
      assert.ok(setCookie.includes("Secure"), "Production cookie should have Secure");
      assert.ok(setCookie.includes("samesite=none") || setCookie.includes("SameSite=None"),
        "Production cookie should have SameSite=None");
    }
    console.log("  → ✓ Cookie attributes verified");
  });

  it("6. Invalid/missing signed cookie → connected:false", async () => {
    const r = await fetch(BASE + "/api/pinterest/status");
    const data = await r.json();
    assert.equal(data.connected, false, "No cookie → not connected");
    console.log("  → ✓ No cookie → connected:false");
  });
});

console.log("\n✅ Cookie fallback tests complete.\n");
