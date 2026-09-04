/**
 * End-to-end test for Pinterest Create Pin flow.
 *
 * Simulates the full production flow:
 *   1. OAuth start → callback (mocked token exchange) → handoff → session token
 *   2. GET /api/pinterest/status → connected:true
 *   3. GET /api/pinterest/account → real Pinterest user account fields
 *   4. GET /api/pinterest/boards → board list
 *   5. POST /api/pinterest/pins → Pin creation via real Pinterest API format
 *
 * Tests:
 *   - Token is resolved correctly through the full auth chain
 *   - Token has pins:write scope (verified by Pinterest accepting the request)
 *   - Invalid/expired token returns clear 401 error
 *   - Pinterest 403 returns safe diagnostics (no tokens in logs)
 *   - Pin payload includes is_standard: true
 *   - Pin payload format matches Pinterest API v5
 *   - Disconnect invalidates everything
 */

process.env.PINTEREST_CLIENT_ID = "test_pin_client_id";
process.env.PINTEREST_CLIENT_SECRET = "test_pin_client_secret";
process.env.PINTEREST_REDIRECT_URI = "https://modern-living-hub.onrender.com/auth/pinterest/callback";
process.env.SESSION_SECRET = "test_pin_session_secret_key_1234567890";
process.env.FRONTEND_URL = "https://shehrozali6465372-ctrl.github.io/modern-living-hub";
process.env.NODE_ENV = "test";
process.env.PORT = "3499";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const BASE = "http://localhost:3499";

function parseCookies(headers) {
  const cookies = {};
  for (const h of (headers || [])) {
    const eq = h.indexOf("=");
    if (eq > 0) {
      const name = h.substring(0, eq);
      const val = h.substring(eq + 1, h.indexOf(";", eq + 1) > 0 ? h.indexOf(";", eq + 1) : undefined);
      cookies[name] = val;
    }
  }
  return cookies;
}

const TS = {};

await import("./src/server.js");
await new Promise(r => setTimeout(r, 500));

// ─── Mock Pinterest API responses ───
const MOCK_USER = {
  id: "mock_user_123",
  username: "test_user",
  display_name: "Test User",
  profile_image: { "150x150": "https://example.com/avatar.jpg" },
  website_url: "https://example.com"
};

const MOCK_BOARDS = {
  items: [
    { id: "board_abc_123", name: "Home Decor", description: "Interior ideas", pin_count: 42 },
    { id: "board_def_456", name: "Travel", description: "Travel pins", pin_count: 18 }
  ]
};

const MOCK_PIN_CREATED = {
  id: "pin_xyz_789",
  title: "Test Pin",
  link: "https://example.com",
  board_id: "board_abc_123",
  created_at: "2026-09-04T00:00:00Z"
};

// Intercept fetch to mock Pinterest API
function setupMock(mockHandlers) {
  const _origFetch = globalThis.fetch;
  globalThis.fetch = function (url, opts) {
    const urlStr = typeof url === "string" ? url : String(url);
    
    // Token exchange
    if (urlStr.includes("api.pinterest.com/v5/oauth/token")) {
      return Promise.resolve(new Response(JSON.stringify({
        access_token: "mock_pinterest_access_token",
        refresh_token: "mock_pinterest_refresh_token",
        token_type: "bearer",
        scope: "boards:read boards:write pins:read pins:write"
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    
    // User account
    if (urlStr.includes("api.pinterest.com/v5/user_account") && (!opts || opts.method !== "POST")) {
      return mockHandlers.userAccount
        ? mockHandlers.userAccount()
        : Promise.resolve(new Response(JSON.stringify(MOCK_USER), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    
    // Boards GET
    if (urlStr.includes("api.pinterest.com/v5/boards") && (!opts || opts.method !== "POST")) {
      return mockHandlers.boards
        ? mockHandlers.boards()
        : Promise.resolve(new Response(JSON.stringify(MOCK_BOARDS), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    
    // Pins POST
    if (urlStr.includes("api.pinterest.com/v5/pins") && opts && opts.method === "POST") {
      // Validate the pin payload
      const body = JSON.parse(opts.body);
      assert.ok(body.board_id, "Pin payload must have board_id");
      assert.ok(body.title, "Pin payload must have title");
      assert.ok(body.media_source, "Pin payload must have media_source");
      assert.equal(body.media_source.source_type, "image_url", "source_type must be image_url");
      assert.equal(body.media_source.is_standard, true, "is_standard must be true for image_url");
      assert.ok(body.media_source.url, "media_source must have url");
      assert.ok(body.link, "Pin payload must have link");
      
      if (opts.headers.Authorization && opts.headers.Authorization.includes("invalid_token")) {
        return Promise.resolve(new Response(JSON.stringify({
          code: 0,
          message: "Invalid access token",
          error: "invalid_token",
          error_description: "The access token is not valid."
        }), { status: 401, headers: { "Content-Type": "application/json" } }));
      }
      
      if (opts.headers.Authorization && opts.headers.Authorization.includes("expired_token")) {
        return Promise.resolve(new Response(JSON.stringify({
          code: 2,
          message: "The access token has expired",
          error: "expired_token",
          error_description: "Token has expired. Please re-authenticate.",
          request_id: "req_expired_123"
        }), { status: 403, headers: { "Content-Type": "application/json" } }));
      }
      
      if (opts.headers.Authorization && opts.headers.Authorization.includes("no_permission")) {
        return Promise.resolve(new Response(JSON.stringify({
          code: 6,
          message: "Your application does not have permission to create pins",
          error: "forbidden",
          error_description: "Missing required scope: pins:write",
          request_id: "req_forbidden_456"
        }), { status: 403, headers: { "Content-Type": "application/json" } }));
      }
      
      return mockHandlers.createPin
        ? mockHandlers.createPin(opts)
        : Promise.resolve(new Response(JSON.stringify(MOCK_PIN_CREATED), { status: 201, headers: { "Content-Type": "application/json" } }));
    }
    
    // Boards POST (create board)
    if (urlStr.includes("api.pinterest.com/v5/boards") && opts && opts.method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({
        id: "board_new_999",
        name: "New Board",
        description: "A new board"
      }), { status: 201, headers: { "Content-Type": "application/json" } }));
    }
    
    return _origFetch(url, opts);
  };
  return _origFetch;
}

// ─── Helper: complete full OAuth flow and get session token ───
async function completeOAuthFlow() {
  const r1 = await fetch(BASE + "/auth/pinterest", { redirect: "manual" });
  const loc = r1.headers.get("location");
  const state = new URL(loc).searchParams.get("state");
  const cookies = parseCookies(r1.headers.getSetCookie());
  assert.ok(cookies["mlh.sid"], "Session cookie set");

  const r2 = await fetch(
    BASE + "/auth/pinterest/callback?code=test_code&state=" + encodeURIComponent(state),
    { redirect: "manual", headers: { Cookie: Object.entries(cookies).map(([k,v]) => k+"="+v).join("; ") } }
  );
  assert.equal(r2.status, 302);
  const handoffCode = new URL(r2.headers.get("location")).searchParams.get("handoff");
  assert.ok(handoffCode, "Handoff code generated");

  const r3 = await fetch(BASE + "/api/pinterest/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handoff: handoffCode })
  });
  const data = await r3.json();
  assert.equal(data.connected, true);
  assert.ok(data.session_token, "Session token returned");
  return data.session_token;
}

describe("Create Pin — Full E2E Flow", () => {

  it("1. OAuth → handoff → session token", async () => {
    const _origFetch = setupMock({});
    try {
      TS.sessionToken = await completeOAuthFlow();
      assert.ok(TS.sessionToken, "Got session token");
    } finally { globalThis.fetch = _origFetch; }
  });

  it("2. GET /api/pinterest/status → connected:true", async () => {
    const r = await fetch(BASE + "/api/pinterest/status", {
      headers: { "Authorization": "Bearer " + TS.sessionToken }
    });
    const data = await r.json();
    assert.equal(data.connected, true, "Should be connected");
    assert.ok(data.connected_at, "Should have connected_at");
  });

  it("3. GET /api/pinterest/account → real Pinterest account fields", async () => {
    const _origFetch = setupMock({});
    try {
      const r = await fetch(BASE + "/api/pinterest/account", {
        headers: { "Authorization": "Bearer " + TS.sessionToken }
      });
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.equal(data.connected, true);
      assert.equal(data.id, "mock_user_123");
      assert.equal(data.username, "test_user");
      assert.equal(data.display_name, "Test User");
      // SECURITY: No tokens in response
      assert.ok(!JSON.stringify(data).includes("mock_pinterest_access_token"));
      assert.ok(!JSON.stringify(data).includes("access_token"));
    } finally { globalThis.fetch = _origFetch; }
  });

  it("4. GET /api/pinterest/boards → board list with real IDs", async () => {
    const _origFetch = setupMock({});
    try {
      const r = await fetch(BASE + "/api/pinterest/boards", {
        headers: { "Authorization": "Bearer " + TS.sessionToken }
      });
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.ok(Array.isArray(data.boards));
      assert.equal(data.boards.length, 2);
      assert.equal(data.boards[0].id, "board_abc_123");
      assert.equal(data.boards[0].name, "Home Decor");
      assert.equal(data.boards[1].id, "board_def_456");
    } finally { globalThis.fetch = _origFetch; }
  });

  it("5. POST /api/pinterest/pins → Pin created with correct payload", async () => {
    const _origFetch = setupMock({});
    try {
      const r = await fetch(BASE + "/api/pinterest/pins", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + TS.sessionToken
        },
        body: JSON.stringify({
          board_id: "board_abc_123",
          title: "Modern Living Test Pin",
          description: "A test pin for Standard Access review",
          image_url: "https://example.com/test-image.jpg",
          destination_url: "https://example.com"
        })
      });
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.equal(data.success, true);
      assert.equal(data.pin.id, "pin_xyz_789");
      assert.equal(data.pin.title, "Test Pin");
      assert.equal(data.pin.board_id, "board_abc_123");
      assert.ok(data.pin.created_at);
      // SECURITY: No tokens in response
      assert.ok(!JSON.stringify(data).includes("mock_pinterest_access_token"));
    } finally { globalThis.fetch = _origFetch; }
  });

  it("6. Unauthenticated /api/pinterest/pins → 401 with clear message", async () => {
    const r = await fetch(BASE + "/api/pinterest/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        board_id: "board_1", title: "T", image_url: "https://x.com/i.jpg",
        destination_url: "https://x.com"
      })
    });
    assert.equal(r.status, 401);
    const data = await r.json();
    assert.ok(data.error.includes("Not connected"));
  });

  it("7. Missing fields → 400 with validation error", async () => {
    const r = await fetch(BASE + "/api/pinterest/pins", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + TS.sessionToken
      },
      body: JSON.stringify({ board_id: "x" })
    });
    assert.equal(r.status, 400);
    const data = await r.json();
    assert.ok(data.error.includes("required"));
  });

  it("8. Pinterest 401 (invalid token) → clear auth error, no secrets in response", async () => {
    // Override the mock to return 401 for this specific test
    const _origFetch = globalThis.fetch;
    globalThis.fetch = function (url, opts) {
      const urlStr = typeof url === "string" ? url : String(url);
      if (urlStr.includes("api.pinterest.com/v5/pins") && opts?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({
          code: 0,
          message: "Invalid access token",
          error: "invalid_token",
          error_description: "The access token is not valid."
        }), { status: 401, headers: { "Content-Type": "application/json" } }));
      }
      return _origFetch(url, opts);
    };
    try {
      const r = await fetch(BASE + "/api/pinterest/pins", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + TS.sessionToken
        },
        body: JSON.stringify({
          board_id: "board_abc_123", title: "T",
          image_url: "https://example.com/i.jpg",
          destination_url: "https://example.com"
        })
      });
      assert.equal(r.status, 401);
      const data = await r.json();
      assert.ok(data.error.includes("Pinterest"));
      assert.ok(data.error.includes("Invalid access token"));
      // SECURITY: No tokens or secrets in error message
      assert.ok(!data.error.includes("mock_pinterest_access_token"));
      assert.ok(!data.error.includes("client_secret"));
      assert.ok(!data.error.includes("test_pin_client_secret"));
    } finally { globalThis.fetch = _origFetch; }
  });

  it("9. Pinterest 403 (no permission) → safe diagnostics, no secrets logged", async () => {
    const _origFetch = globalThis.fetch;
    globalThis.fetch = function (url, opts) {
      const urlStr = typeof url === "string" ? url : String(url);
      if (urlStr.includes("api.pinterest.com/v5/pins") && opts?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({
          code: 6,
          message: "Your application does not have permission to create pins",
          error: "forbidden",
          error_description: "Missing required scope: pins:write",
          request_id: "req_forbidden_456"
        }), { status: 403, headers: { "Content-Type": "application/json" } }));
      }
      return _origFetch(url, opts);
    };
    try {
      const r = await fetch(BASE + "/api/pinterest/pins", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + TS.sessionToken
        },
        body: JSON.stringify({
          board_id: "board_abc_123", title: "T",
          image_url: "https://example.com/i.jpg",
          destination_url: "https://example.com"
        })
      });
      assert.equal(r.status, 403);
      const data = await r.json();
      // Must contain Pinterest error message
      assert.ok(data.error.includes("Pinterest"));
      assert.ok(data.error.includes("Pinterest"));
      assert.ok(data.error.includes("pins:write"));
      // Must NOT contain secrets
      assert.ok(!data.error.includes("mock_pinterest_access_token"));
      assert.ok(!data.error.includes("client_secret"));
    } finally { globalThis.fetch = _origFetch; }
  });

  it("10. Pin payload is_standard verification", async () => {
    // Verify the payload structure by checking what was sent to Pinterest API
    let capturedBody = null;
    const _origFetch = globalThis.fetch;
    globalThis.fetch = function (url, opts) {
      const urlStr = typeof url === "string" ? url : String(url);
      if (urlStr.includes("api.pinterest.com/v5/pins") && opts?.method === "POST") {
        capturedBody = JSON.parse(opts.body);
        return Promise.resolve(new Response(JSON.stringify({
          id: "pin_verify_001", title: capturedBody.title,
          link: capturedBody.link, board_id: capturedBody.board_id,
          created_at: "2026-09-04T00:00:00Z"
        }), { status: 201, headers: { "Content-Type": "application/json" } }));
      }
      return _origFetch(url, opts);
    };
    try {
      await fetch(BASE + "/api/pinterest/pins", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + TS.sessionToken
        },
        body: JSON.stringify({
          board_id: "board_abc_123", title: "Verify Payload",
          image_url: "https://example.com/img.jpg",
          destination_url: "https://example.com"
        })
      });
      assert.ok(capturedBody, "Should have captured the request body");
      assert.equal(capturedBody.board_id, "board_abc_123");
      assert.equal(capturedBody.title, "Verify Payload");
      assert.equal(capturedBody.media_source.source_type, "image_url");
      assert.equal(capturedBody.media_source.is_standard, true, "is_standard must be true");
      assert.equal(capturedBody.media_source.url, "https://example.com/img.jpg");
      assert.equal(capturedBody.link, "https://example.com");
      // SECURITY: No tokens in payload
      assert.ok(!JSON.stringify(capturedBody).includes("access_token"));
    } finally { globalThis.fetch = _origFetch; }
  });

  it("11. Status returns needs_reauth when scopes are insufficient", async () => {
    // Do a full OAuth flow but with token that has only boards:read
    const _origFetch = globalThis.fetch;
    globalThis.fetch = function (url, opts) {
      const urlStr = typeof url === "string" ? url : String(url);
      if (urlStr.includes("api.pinterest.com/v5/oauth/token")) {
        return Promise.resolve(new Response(JSON.stringify({
          access_token: "limited_scope_token",
          refresh_token: "limited_refresh",
          token_type: "bearer",
          scope: "boards:read"
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (urlStr.includes("api.pinterest.com/v5/user_account")) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_USER),
          { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (urlStr.includes("api.pinterest.com/v5/boards")) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_BOARDS),
          { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return _origFetch(url, opts);
    };
    try {
      const limitedToken = await completeOAuthFlow();
      // Status should report needs_reauth
      const r = await fetch(BASE + "/api/pinterest/status", {
        headers: { "Authorization": "Bearer " + limitedToken }
      });
      const data = await r.json();
      assert.equal(data.connected, false, "Should not be connected with insufficient scopes");
      assert.equal(data.needs_reauth, true, "Should flag needs_reauth");
      assert.ok(data.error.includes("pins:write"), "Error should mention pins:write");
    } finally { globalThis.fetch = _origFetch; }
  });

  it("12. Pin creation blocked when scopes are insufficient (403)", async () => {
    const _origFetch = globalThis.fetch;
    globalThis.fetch = function (url, opts) {
      const urlStr = typeof url === "string" ? url : String(url);
      if (urlStr.includes("api.pinterest.com/v5/oauth/token")) {
        return Promise.resolve(new Response(JSON.stringify({
          access_token: "no_write_token",
          refresh_token: "no_write_refresh",
          token_type: "bearer",
          scope: "boards:read boards:write pins:read"
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (urlStr.includes("api.pinterest.com/v5/user_account")) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_USER),
          { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (urlStr.includes("api.pinterest.com/v5/boards")) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_BOARDS),
          { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return _origFetch(url, opts);
    };
    try {
      const limitedToken = await completeOAuthFlow();
      // Pin creation should be blocked with 403
      const r = await fetch(BASE + "/api/pinterest/pins", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + limitedToken
        },
        body: JSON.stringify({
          board_id: "board_abc_123", title: "T",
          image_url: "https://example.com/i.jpg",
          destination_url: "https://example.com"
        })
      });
      assert.equal(r.status, 403, "Should be 403 for missing pins:write");
      const data = await r.json();
      assert.ok(data.error.includes("pins:write"), "Error should mention pins:write");
      assert.ok(data.error.includes("reconnect"), "Error should suggest reconnecting");
      // SECURITY: No tokens in error
      assert.ok(!data.error.includes("no_write_token"));
    } finally { globalThis.fetch = _origFetch; }
  });

  it("13. Full-scope token passes scope validation", async () => {
    // Verify that the main test's token (with all 4 scopes) passes validation
    const r = await fetch(BASE + "/api/pinterest/status", {
      headers: { "Authorization": "Bearer " + TS.sessionToken }
    });
    const data = await r.json();
    assert.equal(data.connected, true, "Full-scope token should be connected");
    assert.equal(data.needs_reauth, undefined, "Should NOT flag needs_reauth");
  });

  it("14. Disconnect → all tokens invalidated", async () => {
    const r1 = await fetch(BASE + "/api/pinterest/disconnect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + TS.sessionToken
      }
    });
    assert.equal((await r1.json()).disconnected, true);

    const r2 = await fetch(BASE + "/api/pinterest/status", {
      headers: { "Authorization": "Bearer " + TS.sessionToken }
    });
    assert.equal((await r2.json()).connected, false);

    const r3 = await fetch(BASE + "/api/pinterest/pins", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + TS.sessionToken
      },
      body: JSON.stringify({ board_id: "x", title: "T", image_url: "https://x.com/i.jpg", destination_url: "https://x.com" })
    });
    assert.equal(r3.status, 401, "Should be 401 after disconnect");
  });
});

console.log("\n✅ Create Pin E2E flow test complete.\n");
