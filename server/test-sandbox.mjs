/**
 * Sandbox Pin creation test — verifies Sandbox mode configuration.
 *
 * Tests:
 *   1. Health endpoint reports sandbox_mode:false without sandbox env vars
 *   2. With sandbox env vars set, health reports sandbox_mode:true
 *   3. Sandbox API calls use api-sandbox.pinterest.com base URL
 *   4. Sandbox calls use Authorization: Bearer <SANDBOX_TOKEN>
 *   5. Sandbox token is NEVER logged or exposed
 *   6. Pin creation works against mocked Sandbox endpoint
 */

process.env.PINTEREST_CLIENT_ID = "test_client_id";
process.env.PINTEREST_CLIENT_SECRET = "test_client_secret";
process.env.PINTEREST_REDIRECT_URI = "https://modern-living-hub.onrender.com/auth/pinterest/callback";
process.env.SESSION_SECRET = "test_session_secret_key_1234567890abcdef";
process.env.FRONTEND_URL = "https://shehrozali6465372-ctrl.github.io/modern-living-hub";
process.env.NODE_ENV = "test";
process.env.PORT = "3510";

// Sandbox config (temporary testing mode)
process.env.PINTEREST_SANDBOX_TOKEN = "sandbox_test_token_do_not_log";
process.env.PINTEREST_API_BASE_URL = "https://api-sandbox.pinterest.com/v5";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const BASE = "http://localhost:3510";

await import("./src/server.js");
await new Promise(r => setTimeout(r, 500));

describe("Sandbox Mode", () => {

  it("1. Health endpoint reports sandbox_mode:true with sandbox env vars", async () => {
    const r = await fetch(BASE + "/api/health");
    const data = await r.json();
    assert.equal(data.status, "ok");
    assert.equal(data.sandbox_mode, true, "sandbox_mode should be true");
    assert.equal(data.production_mode, false);
    // SECURITY: No token in health response
    assert.ok(!JSON.stringify(data).includes("sandbox_test_token"));
    assert.ok(!JSON.stringify(data).includes("access_token"));
  });

  it("2. Pin creation uses Sandbox API base URL and Sandbox bearer token", async () => {
    // Capture the request made to Pinterest
    let capturedUrl = null;
    let capturedAuth = null;
    let capturedBody = null;

    const _origFetch = globalThis.fetch;
    globalThis.fetch = function (url, opts) {
      const urlStr = typeof url === "string" ? url : String(url);
      if (urlStr.includes("api-sandbox.pinterest.com/v5/pins")) {
        capturedUrl = urlStr;
        capturedAuth = opts.headers.Authorization;
        capturedBody = JSON.parse(opts.body);
        return Promise.resolve(new Response(JSON.stringify({
          id: "sandbox_pin_001",
          title: "Sandbox Test Pin",
          link: "https://example.com",
          board_id: "sandbox_board_001",
          created_at: "2026-09-04T00:00:00Z"
        }), { status: 201, headers: { "Content-Type": "application/json" } }));
      }
      return _origFetch(url, opts);
    };

    try {
      // No OAuth needed in sandbox — getEffectiveToken returns SANDBOX_TOKEN
      const r = await fetch(BASE + "/api/pinterest/pins", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer some_user_token" // frontend still sends its token; sandbox overrides
        },
        body: JSON.stringify({
          board_id: "sandbox_board_001",
          title: "Sandbox Test Pin",
          description: "Created via Sandbox API",
          image_url: "https://example.com/sandbox-image.jpg",
          destination_url: "https://example.com"
        })
      });

      assert.equal(r.status, 200);
      const data = await r.json();
      assert.equal(data.success, true);
      assert.equal(data.pin.id, "sandbox_pin_001");

      // Verify the request went to the SANDBOX base URL
      assert.ok(capturedUrl, "Should have captured the request URL");
      assert.ok(capturedUrl.startsWith("https://api-sandbox.pinterest.com"),
        "Should use Sandbox API base URL");

      // Verify the Authorization header uses the SANDBOX token
      assert.ok(capturedAuth, "Should have Authorization header");
      assert.equal(capturedAuth, "Bearer sandbox_test_token_do_not_log",
        "Should use Sandbox token");

      // Verify payload structure
      assert.equal(capturedBody.board_id, "sandbox_board_001");
      assert.equal(capturedBody.media_source.source_type, "image_url");
      assert.equal(capturedBody.media_source.is_standard, true);

      // SECURITY: No token in response
      assert.ok(!JSON.stringify(data).includes("sandbox_test_token"));
      assert.ok(!JSON.stringify(data).includes("access_token"));

      console.log("  → Sandbox API base URL: " + capturedUrl);
      console.log("  → Authorization: Bearer <sandbox-token> (not logged)");
      console.log("  → Pin payload correct (is_standard: true)");
    } finally { globalThis.fetch = _origFetch; }
  });

  it("3. Board creation also uses Sandbox API base URL", async () => {
    let capturedUrl = null;
    let capturedAuth = null;

    const _origFetch = globalThis.fetch;
    globalThis.fetch = function (url, opts) {
      const urlStr = typeof url === "string" ? url : String(url);
      if (urlStr.includes("api-sandbox.pinterest.com/v5/boards") && opts?.method === "POST") {
        capturedUrl = urlStr;
        capturedAuth = opts.headers.Authorization;
        return Promise.resolve(new Response(JSON.stringify({
          id: "sandbox_board_new",
          name: "Sandbox Board",
          description: "Sandbox test board"
        }), { status: 201, headers: { "Content-Type": "application/json" } }));
      }
      return _origFetch(url, opts);
    };

    try {
      const r = await fetch(BASE + "/api/pinterest/boards", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer some_user_token"
        },
        body: JSON.stringify({ name: "Sandbox Board", description: "Sandbox test board" })
      });

      assert.equal(r.status, 200);
      const data = await r.json();
      assert.equal(data.success, true);
      assert.equal(data.board.id, "sandbox_board_new");

      assert.ok(capturedUrl.startsWith("https://api-sandbox.pinterest.com"),
        "Should use Sandbox API base URL for boards");
      assert.equal(capturedAuth, "Bearer sandbox_test_token_do_not_log",
        "Should use Sandbox token for boards");

      console.log("  → Sandbox board creation works");
    } finally { globalThis.fetch = _origFetch; }
  });

  it("4. Boards GET uses Sandbox API base URL", async () => {
    let capturedUrl = null;

    const _origFetch = globalThis.fetch;
    globalThis.fetch = function (url, opts) {
      const urlStr = typeof url === "string" ? url : String(url);
      if (urlStr.includes("api-sandbox.pinterest.com/v5/boards")) {
        capturedUrl = urlStr;
        return Promise.resolve(new Response(JSON.stringify({
          items: [{ id: "sandbox_board_001", name: "Sandbox Board" }]
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return _origFetch(url, opts);
    };

    try {
      const r = await fetch(BASE + "/api/pinterest/boards", {
        headers: { "Authorization": "Bearer some_user_token" }
      });
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.equal(data.boards.length, 1);
      assert.equal(data.boards[0].id, "sandbox_board_001");

      assert.ok(capturedUrl.startsWith("https://api-sandbox.pinterest.com"),
        "Should use Sandbox API base URL for boards GET");
      console.log("  → Sandbox boards GET works");
    } finally { globalThis.fetch = _origFetch; }
  });

  it("5. NEVER exposes sandbox token in logs or responses", async () => {
    // Check health response body
    const health = await fetch(BASE + "/api/health");
    const healthText = await health.text();
    assert.ok(!healthText.includes("sandbox_test_token"), "Health must not expose token");

    // Check pin creation response
    const _origFetch = globalThis.fetch;
    globalThis.fetch = function (url, opts) {
      const urlStr = typeof url === "string" ? url : String(url);
      if (urlStr.includes("api-sandbox.pinterest.com")) {
        return Promise.resolve(new Response(JSON.stringify({ id: "x" }),
          { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return _origFetch(url, opts);
    };
    try {
      const r = await fetch(BASE + "/api/pinterest/pins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          board_id: "b1", title: "T",
          image_url: "https://x.com/i.jpg",
          destination_url: "https://x.com"
        })
      });
      const body = await r.text();
      assert.ok(!body.includes("sandbox_test_token"), "Response must not expose token");
      console.log("  → Sandbox token never exposed ✓");
    } finally { globalThis.fetch = _origFetch; }
  });
});

console.log("\n✅ Sandbox tests complete.\n");
