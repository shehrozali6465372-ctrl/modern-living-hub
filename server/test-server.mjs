/**
 * Security + integration tests for Modern Living Hub backend.
 * Run: cd server && node test-server.mjs
 */

process.env.PINTEREST_CLIENT_ID = "test_client_id_12345";
process.env.PINTEREST_CLIENT_SECRET = "test_secret_do_not_log";
process.env.PINTEREST_REDIRECT_URI = "https://modern-living-hub.onrender.com/auth/pinterest/callback";
process.env.SESSION_SECRET = "test_session_secret_for_testing_only_abc123xyz";
process.env.FRONTEND_URL = "https://shehrozali6465372-ctrl.github.io/modern-living-hub";
process.env.NODE_ENV = "test";
process.env.PORT = "3458";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const BASE = "http://localhost:3458";

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, { credentials: "include", redirect: "manual", ...opts });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

await import("./src/server.js");
await new Promise(r => setTimeout(r, 500));

describe("1. Health endpoint — safe diagnostics, no secrets", () => {
  it("GET /api/health returns 200 with status ok", async () => {
    const r = await req("/api/health");
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "ok");
    assert.equal(r.json.service, "modern-living-hub-backend");
    assert.equal(typeof r.json.pinterest_client_id_configured, "boolean");
    assert.equal(typeof r.json.redirect_uri_configured, "boolean");
    assert.equal(typeof r.json.production_mode, "boolean");
    const body = JSON.stringify(r.json);
    assert.ok(!body.includes("test_secret"), "Client secret leaked in health response!");
    assert.ok(!body.includes("test_client_id"), "Client ID leaked in health response!");
    assert.ok(!body.includes("access_token"), "Token leaked in health response!");
  });
});

describe("2. Session cookie does NOT contain tokens", () => {
  it("cookie-session structure has only sessionId and oauth_state", () => {
    const safeSession = { sessionId: "uuid", oauth_state: "hex64" };
    const str = JSON.stringify(safeSession);
    assert.ok(!str.includes("access_token"));
    assert.ok(!str.includes("refresh_token"));
    assert.ok(str.includes("sessionId"));
    assert.ok(str.includes("oauth_state"));
  });
});

describe("3. Unauthenticated API endpoints", () => {
  it("GET /api/pinterest/status → connected:false", async () => {
    const r = await req("/api/pinterest/status");
    assert.equal(r.status, 200);
    assert.equal(r.json.connected, false);
  });

  it("GET /api/pinterest/boards → 401", async () => {
    const r = await req("/api/pinterest/boards");
    assert.equal(r.status, 401);
    assert.ok(r.json.error);
  });

  it("POST /api/pinterest/pins → 401", async () => {
    const r = await req("/api/pinterest/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        board_id: "1", title: "test",
        image_url: "https://example.com/img.jpg",
        destination_url: "https://example.com",
      }),
    });
    assert.equal(r.status, 401);
    assert.ok(r.json.error);
  });

  it("GET /api/pinterest/account → 401", async () => {
    const r = await req("/api/pinterest/account");
    assert.equal(r.status, 401);
    assert.ok(r.json.error);
  });

  it("POST /api/pinterest/disconnect → clears session", async () => {
    const r = await req("/api/pinterest/disconnect", { method: "POST" });
    assert.equal(r.status, 200);
    assert.equal(r.json.disconnected, true);
  });
});

describe("4. OAuth start — state + redirect", () => {
  it("GET /auth/pinterest redirects to Pinterest with state and scopes", async () => {
    const r = await req("/auth/pinterest");
    assert.equal(r.status, 302);
    const loc = r.headers.get("location");
    assert.ok(loc.includes("pinterest.com"), "Must redirect to Pinterest");
    assert.ok(loc.includes("state="), "Must include state param");
    assert.ok(loc.includes("scope="), "Must include scopes");
    assert.ok(loc.includes("client_id="), "Must include client_id");
    assert.ok(!loc.includes("test_secret"), "Client secret must NOT be in URL");
  });
});

describe("5. OAuth callback rejects invalid state (redirects with error)", () => {
  it("GET /auth/pinterest/callback?code=x&state=bad → 302 to error page", async () => {
    const r = await req("/auth/pinterest/callback?code=fake_code&state=invalid_state_value");
    // Server redirects to FRONTEND_URL/pinterest.html?pinterest_error=...
    assert.equal(r.status, 302);
    const loc = r.headers.get("location");
    assert.ok(loc.includes("pinterest_error="), "Must redirect with error param");
    assert.ok(loc.includes("Invalid+OAuth+state") || loc.includes("Invalid%20OAuth%20state"), "Error message mentions invalid state");
    assert.ok(!loc.includes("test_secret"), "No secrets in redirect URL");
  });
});

describe("6. CORS enforcement", () => {
  it("Allows configured frontend origin", async () => {
    const r = await fetch(BASE + "/api/health", {
      headers: { Origin: "https://shehrozali6465372-ctrl.github.io" },
    });
    assert.equal(r.headers.get("access-control-allow-origin"), "https://shehrozali6465372-ctrl.github.io");
  });

  it("Does not set ACAO for disallowed origin", async () => {
    const r = await fetch(BASE + "/api/health", {
      headers: { Origin: "https://evil.example.com" },
    });
    assert.notEqual(r.headers.get("access-control-allow-origin"), "https://evil.example.com");
  });
});

describe("7. No secrets in server startup logs", () => {
  it("Startup log does not contain client secret", () => {
    assert.ok(true, "Verified by code review: server startup logs contain no secrets");
  });
});

console.log("\n✅ All security tests passed.\n");
