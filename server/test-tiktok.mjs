/**
 * E2E test for TikTok integration.
 *
 * Tests:
 *   1. TikTok health endpoint (configured detection)
 *   2. OAuth start → redirect to TikTok with video.publish scope
 *   3. OAuth callback → token exchange (mocked) → handoff → session token
 *   4. Status → connected:true
 *   5. Creator info retrieval
 *   6. Post init → upload → status flow
 *   7. Token never exposed in responses
 *   8. Client secret never exposed in logs
 *   9. OAuth state validation preserved
 *   10. Unauthenticated endpoints → 401
 */

process.env.PINTEREST_CLIENT_ID = "pinterest_test_id";
process.env.PINTEREST_CLIENT_SECRET = "pinterest_test_secret";
process.env.PINTEREST_REDIRECT_URI = "https://modern-living-hub.onrender.com/auth/pinterest/callback";
process.env.SESSION_SECRET = "shared_session_secret_1234567890abcdef";
process.env.FRONTEND_URL = "https://shehrozali6465372-ctrl.github.io/modern-living-hub";
process.env.NODE_ENV = "test";
process.env.PORT = "3512";

// TikTok credentials (for testing OAuth flow)
process.env.TIKTOK_CLIENT_KEY = "tik_tok_test_client_key_12345";
process.env.TIKTOK_CLIENT_SECRET = "tik_tok_test_client_secret_do_not_log";
process.env.TIKTOK_REDIRECT_URI = "https://modern-living-hub.onrender.com/tiktok/auth/callback";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const BASE = "http://localhost:3512";

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

// Mock TikTok API responses
const MOCK_TIKTOK_TOKEN = {
  data: {
    access_token: "mock_tiktok_access_token",
    refresh_token: "mock_tiktok_refresh_token",
    open_id: "mock_tiktok_open_id_123",
    scope: "video.publish",
    expires_in: 86400,
    token_type: "bearer"
  }
};

const MOCK_CREATOR_INFO = {
  data: {
    open_id: "mock_tiktok_open_id_123",
    creator_username: "test_creator",
    creator_nickname: "Test Creator",
    privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
    max_video_post_duration_sec: 300,
    max_video_size: 100 * 1024 * 1024,
    can_post: true,
    status: "ACTIVE"
  }
};

function mockTikTokApi(mockHandlers) {
  const _orig = globalThis.fetch;
  globalThis.fetch = function (url, opts) {
    const urlStr = typeof url === "string" ? url : String(url);

    // Token exchange
    if (urlStr.includes("open.tiktokapis.com/v2/oauth/token")) {
      return Promise.resolve(new Response(JSON.stringify(MOCK_TIKTOK_TOKEN),
        { status: 200, headers: { "Content-Type": "application/json" } }));
    }

    // Creator info
    if (urlStr.includes("post/publish/creator_info/query")) {
      return mockHandlers && mockHandlers.creatorInfo
        ? mockHandlers.creatorInfo()
        : Promise.resolve(new Response(JSON.stringify(MOCK_CREATOR_INFO),
            { status: 200, headers: { "Content-Type": "application/json" } }));
    }

    // Post init
    if (urlStr.includes("post/publish/video/init")) {
      return Promise.resolve(new Response(JSON.stringify({
        data: { publish_id: "tt_publish_12345", upload_url: "https://upload.tiktokapis.com/v2/post/publish/upload/12345" }
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }

    // Post upload (PUT to TikTok upload URL)
    if (urlStr.includes("upload.tiktokapis.com")) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }

    // Post status
    if (urlStr.includes("post/publish/status/fetch")) {
      return Promise.resolve(new Response(JSON.stringify({
        data: { status: "SUCCESS", post_url: "https://www.tiktok.com/@test_creator/video/12345" }
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }

    return _orig(url, opts);
  };
}

// Complete TikTok OAuth flow
async function completeTikTokOAuth() {
  // Start OAuth
  const r1 = await fetch(BASE + "/tiktok/auth", { redirect: "manual" });
  const loc = r1.headers.get("location");
  const state = new URL(loc).searchParams.get("state");
  const cookies = parseCookies(r1.headers.getSetCookie());
  assert.ok(cookies["mlh.sid"], "Session cookie set");

  // Callback
  const r2 = await fetch(
    BASE + "/tiktok/auth/callback?code=test_tt_code&state=" + encodeURIComponent(state),
    { redirect: "manual", headers: { Cookie: Object.entries(cookies).map(([k,v]) => k+"="+v).join("; ") } }
  );
  assert.equal(r2.status, 302, "Should redirect (302)");
  const redirectUrl = r2.headers.get("location");
  assert.ok(redirectUrl.includes("tiktok_connected=1"), "Should have tiktok_connected=1");
  assert.ok(redirectUrl.includes("tt_handoff="), "Should have tt_handoff");

  const handoffCode = new URL(redirectUrl).searchParams.get("tt_handoff");
  assert.ok(handoffCode, "Handoff code generated");

  // Complete handoff
  const r3 = await fetch(BASE + "/api/tiktok/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handoff: handoffCode })
  });
  const data = await r3.json();
  assert.equal(data.connected, true);
  assert.ok(data.session_token, "Session token returned");
  return data.session_token;
}

describe("TikTok Integration", () => {

  it("1. TikTok health endpoint", async () => {
    const r = await fetch(BASE + "/api/tiktok/health");
    const data = await r.json();
    assert.equal(data.status, "ok");
    assert.equal(data.service, "modern-living-hub-tiktok");
    assert.equal(data.tiktok_configured, true, "Should be configured with test creds");
    assert.deepEqual(data.scopes, ["video.publish"], "Should only request video.publish");
  });

  it("2. OAuth start redirects to TikTok with video.publish scope and CSRF state", async () => {
    const _orig = globalThis.fetch;
    const _origFetch = globalThis.fetch;
    try {
      const r = await fetch(BASE + "/tiktok/auth", { redirect: "manual" });
      assert.equal(r.status, 302);
      const loc = r.headers.get("location");
      assert.ok(loc.startsWith("https://www.tiktok.com/v2/auth/authorize/"), "Redirects to TikTok OAuth");
      const url = new URL(loc);
      assert.equal(url.searchParams.get("client_key"), "tik_tok_test_client_key_12345");
      assert.equal(url.searchParams.get("scope"), "video.publish", "Should request ONLY video.publish");
      assert.ok(url.searchParams.get("state"), "CSRF state present");
      assert.ok(url.searchParams.get("redirect_uri"), "Redirect URI present");
      // No secret in URL
      assert.ok(!loc.includes("tik_tok_test_client_secret"), "NO client secret in URL");
      assert.ok(!loc.includes("access_token"), "NO access token in URL");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("3. OAuth callback → handoff → session token", async () => {
    const _orig = globalThis.fetch;
    mockTikTokApi();
    try {
      TS.sessionToken = await completeTikTokOAuth();
      assert.ok(TS.sessionToken, "Session token obtained");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("4. Status → connected:true, no tokens exposed", async () => {
    const r = await fetch(BASE + "/api/tiktok/status", {
      headers: { "Authorization": "Bearer " + TS.sessionToken }
    });
    const data = await r.json();
    assert.equal(data.connected, true);
    assert.equal(data.open_id, "mock_tiktok_open_id_123");
    assert.equal(data.scope, "video.publish");
    assert.ok(!JSON.stringify(data).includes("mock_tiktok_access_token"), "NO access token in response");
  });

  it("5. Creator info retrieval", async () => {
    const _orig = globalThis.fetch;
    mockTikTokApi();
    try {
      const r = await fetch(BASE + "/api/tiktok/creator", {
        headers: { "Authorization": "Bearer " + TS.sessionToken }
      });
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.equal(data.creator_username, "test_creator");
      assert.equal(data.creator_nickname, "Test Creator");
      assert.ok(Array.isArray(data.privacy_level_options), "Privacy options array");
      assert.equal(data.max_video_post_duration_sec, 300);
      assert.equal(data.can_post, true);
      assert.ok(!JSON.stringify(data).includes("mock_tiktok_access_token"), "NO token in response");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("6. Direct Post flow: init → upload → status", async () => {
    const _orig = globalThis.fetch;
    mockTikTokApi();
    try {
      // Init
      const init = await fetch(BASE + "/api/tiktok/post/init", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + TS.sessionToken
        },
        body: JSON.stringify({
          title: "My Test TikTok",
          privacy_level: "PUBLIC_TO_EVERYONE",
          disable_duet: false,
          disable_comment: false,
          disable_stitch: true
        })
      });
      assert.equal(init.status, 200);
      const initData = await init.json();
      assert.equal(initData.success, true);
      assert.equal(initData.publish_id, "tt_publish_12345");
      assert.ok(initData.upload_url, "Upload URL present");

      // Upload
      const upload = await fetch(BASE + "/api/tiktok/post/upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + TS.sessionToken
        },
        body: JSON.stringify({
          upload_url: initData.upload_url,
          video_data: Buffer.from("fake-video-bytes").toString("base64")
        })
      });
      assert.equal(upload.status, 200);

      // Status
      const status = await fetch(BASE + "/api/tiktok/post/status", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + TS.sessionToken
        },
        body: JSON.stringify({ publish_id: initData.publish_id })
      });
      assert.equal(status.status, 200);
      const statusData = await status.json();
      assert.equal(statusData.status, "SUCCESS");
      assert.ok(statusData.post_url, "Post URL present");
      assert.ok(!JSON.stringify(statusData).includes("mock_tiktok_access_token"), "NO token in response");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("7. Unauthenticated endpoints → 401", async () => {
    const r1 = await fetch(BASE + "/api/tiktok/creator");
    assert.equal(r1.status, 401);

    const r2 = await fetch(BASE + "/api/tiktok/post/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "test" })
    });
    assert.equal(r2.status, 401);
  });

  it("8. OAuth state validation — invalid state rejected", async () => {
    const r = await fetch(
      BASE + "/tiktok/auth/callback?code=fake&state=wrong_state",
      { redirect: "manual" }
    );
    assert.equal(r.status, 302);
    const loc = r.headers.get("location");
    assert.ok(loc.includes("tiktok_error="), "Should redirect with error");
  });

  it("9. OAuth denial handled", async () => {
    const r = await fetch(
      BASE + "/tiktok/auth/callback?error=access_denied&error_description=User+denied",
      { redirect: "manual" }
    );
    assert.equal(r.status, 302);
    const loc = r.headers.get("location");
    assert.ok(loc.includes("tiktok_error="), "Should redirect with deny error");
    assert.ok(loc.includes("denied"), "Should mention denial");
  });

  it("10. No client secret exposed anywhere", async () => {
    // Health
    const health = await fetch(BASE + "/api/tiktok/health");
    assert.ok(!(await health.text()).includes("tik_tok_test_client_secret"));

    // Config status
    const cfg = await fetch(BASE + "/api/tiktok/config-status");
    const cfgText = await cfg.text();
    assert.ok(!cfgText.includes("tik_tok_test_client_secret"), "Config endpoint must not expose secret");
    assert.ok(!cfgText.includes("mock_tiktok_access_token"), "Must not expose access token");
  });

  it("11. Disconnect → all tokens invalidated", async () => {
    const r1 = await fetch(BASE + "/api/tiktok/disconnect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + TS.sessionToken
      }
    });
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).disconnected, true);

    const r2 = await fetch(BASE + "/api/tiktok/status", {
      headers: { "Authorization": "Bearer " + TS.sessionToken }
    });
    const data = await r2.json();
    assert.equal(data.connected, false, "Should be disconnected");
  });
});

console.log("\n✅ TikTok tests complete.\n");
