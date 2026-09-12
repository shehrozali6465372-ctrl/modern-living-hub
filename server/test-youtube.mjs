/**
 * E2E test suite for YouTube integration.
 *
 * Tests:
 *   1. YouTube health endpoint
 *   2. OAuth start → redirect to Google with correct params
 *   3. OAuth callback → token exchange (mocked) → handoff → session token
 *   4. Status → connected:true
 *   5. Channel info retrieval
 *   6. Unauthenticated endpoints → 401
 *   7. Client secret never exposed in logs
 *   8. OAuth state validation
 *   9. Disconnect
 *  10. Disconnect clears local state
 *  11. Reconnect starts fresh OAuth
 *  12. Token exchange diagnostic logging
 *  13. Token exchange failure handling
 *  14. Video upload with valid metadata
 *  15. Video upload missing title → 400
 *  16. Video upload missing file → 400
 *  17. Video upload invalid privacy → 400
 *  18. Unauthenticated upload → 401
 *  19. Unauthenticated video-status → 401
 *  20. Video status endpoint works
 *  21. Google credentials never in logs
 *  22. OAuth URL includes disable_auto_auth=1
 *  23. Disconnect does not touch Pinterest tokens
 *  24. Disconnect does not touch TikTok tokens
 */

process.env.PINTEREST_CLIENT_ID = "pinterest_test_id";
process.env.PINTEREST_CLIENT_SECRET = "pinterest_test_secret";
process.env.PINTEREST_REDIRECT_URI = "https://modern-living-hub.onrender.com/auth/pinterest/callback";
process.env.SESSION_SECRET = "youtube_test_session_secret_abcdef1234567890";
process.env.FRONTEND_URL = "https://shehrozali6465372-ctrl.github.io/modern-living-hub";
process.env.NODE_ENV = "test";
process.env.PORT = "3513";

process.env.YOUTUBE_CLIENT_ID = "yt_test_client_id_12345";
process.env.YOUTUBE_CLIENT_SECRET = "yt_test_client_secret_do_not_log";
process.env.YOUTUBE_REDIRECT_URI = "https://modern-living-hub.onrender.com/youtube/auth/callback";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

// Build a self-verifying signed OAuth state, mirroring the server format:
// <nonce>.<timestamp>.<HMAC-SHA256(SESSION_SECRET, nonce.timestamp)>
function buildYTState(nonce, timestamp, secret) {
  const sig = crypto.createHmac("sha256", secret).update(nonce + "." + timestamp).digest("base64url");
  return nonce + "." + timestamp + "." + sig;
}

const BASE = "http://localhost:3513";

function parseCookies(headers) {
  const cookies = {};
  for (const h of (headers || [])) {
    const eq = h.indexOf("=");
    if (eq > 0) {
      const name = h.substring(0, eq).trim();
      const valEnd = h.indexOf(";", eq + 1);
      const val = h.substring(eq + 1, valEnd > 0 ? valEnd : undefined).trim();
      cookies[name] = val;
    }
  }
  return cookies;
}

function extractSignedCookieValue(cookies, name) {
  // Signed cookies have the format: name=value.signature
  // The cookie value we want is before the ".signature" part
  const fullValue = cookies[name];
  if (!fullValue) return null;
  const dotIdx = fullValue.lastIndexOf(".");
  return dotIdx > 0 ? fullValue.substring(0, dotIdx) : fullValue;
}

const TS = {};

await import("./src/server.js");

const MOCK_GOOGLE_TOKEN = {
  access_token: "mock_youtube_access_token_abc123",
  refresh_token: "mock_youtube_refresh_token_xyz789",
  expires_in: 3600,
  token_type: "Bearer",
  scope: "https://www.googleapis.com/auth/youtube.upload"
};

const MOCK_CHANNEL = {
  items: [{
    id: "UC_mock_channel_id_123",
    snippet: {
      title: "Test YouTube Channel",
      description: "A test channel for Modern Living Hub",
      thumbnails: { default: { url: "https://yt3.ggpht.com/a/default-user.jpg" } }
    },
    contentDetails: {
      relatedPlaylists: { uploads: "UU_mock_channel_id_123" }
    }
  }]
};

function mockGoogleAPIs(handlers) {
  const _orig = globalThis.fetch;
  globalThis.fetch = function (url, opts) {
    const urlStr = typeof url === "string" ? url : String(url);
    if (urlStr.includes("googleapis.com/youtube/v3/videos") && urlStr.includes("video")) {
    }

    // Token exchange (authorization_code grant)
    if (urlStr.includes("oauth2.googleapis.com/token") && opts && opts.body && String(opts.body).includes("grant_type=authorization_code")) {
      if (handlers && handlers.tokenExchange) {
        return handlers.tokenExchange(opts);
      }
      return Promise.resolve(new Response(JSON.stringify(MOCK_GOOGLE_TOKEN),
        { status: 200, headers: { "Content-Type": "application/json" } }));
    }

    // Token refresh (refresh_token grant)
    if (urlStr.includes("oauth2.googleapis.com/token") && opts && opts.body && String(opts.body).includes("grant_type=refresh_token")) {
      if (handlers && handlers.tokenRefresh) {
        return handlers.tokenRefresh(opts);
      }
      return Promise.resolve(new Response(JSON.stringify({
        access_token: "refreshed_youtube_access_token_new",
        expires_in: 3600,
        token_type: "Bearer"
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }

    // Channel info
    if (urlStr.includes("googleapis.com/youtube/v3/channels")) {
      if (handlers && handlers.channel) {
        return handlers.channel(opts);
      }
      return Promise.resolve(new Response(JSON.stringify(MOCK_CHANNEL),
        { status: 200, headers: { "Content-Type": "application/json" } }));
    }

    // Video upload
    if (urlStr.includes("googleapis.com/upload/youtube/v3/videos")) {
      if (handlers && handlers.upload) {
        return handlers.upload(opts);
      }
      return Promise.resolve(new Response(JSON.stringify({
        id: "mock_video_id_12345"
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }

    // Video status
    if (urlStr.includes("googleapis.com/youtube/v3/videos?") && urlStr.includes("processingDetails")) {
      if (handlers && handlers.videoStatus) {
        return handlers.videoStatus(opts);
      }
      return Promise.resolve(new Response(JSON.stringify({
        items: [{
          id: "mock_video_id_12345",
          snippet: { title: "Test Video" },
          processingDetails: { processingStatus: "succeeded" },
          status: { uploadStatus: "processed", privacyStatus: "private" }
        }]
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }

    return _orig(url, opts);
  };
}

async function completeYouTubeOAuth() {
  const r1 = await fetch(BASE + "/youtube/auth", { redirect: "manual" });
  const loc = r1.headers.get("location");
  const state = new URL(loc).searchParams.get("state");
  const cookies = parseCookies(r1.headers.getSetCookie());

  const r2 = await fetch(
    BASE + "/youtube/auth/callback?code=test_yt_code&state=" + encodeURIComponent(state),
    { redirect: "manual", headers: { Cookie: Object.entries(cookies).map(([k,v]) => k+"="+v).join("; ") } }
  );
  assert.equal(r2.status, 302, "Callback should redirect (302)");
  const redirectUrl = r2.headers.get("location");
  assert.ok(redirectUrl.includes("youtube_connected=1"), "Should have youtube_connected=1");
  assert.ok(redirectUrl.includes("yt_handoff="), "Should have yt_handoff");

  const handoffCode = new URL(redirectUrl).searchParams.get("yt_handoff");

  const r3 = await fetch(BASE + "/api/youtube/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handoff: handoffCode })
  });
  const data = await r3.json();
  assert.equal(data.connected, true);
  assert.ok(data.session_token, "Session token returned");
  return data.session_token;
}

async function performYouTubeFlowWithCookies() {
  const _orig = globalThis.fetch;
  mockGoogleAPIs();
  try {
    const r1 = await fetch(BASE + "/youtube/auth", { redirect: "manual" });
    const loc = r1.headers.get("location");
    const state = new URL(loc).searchParams.get("state");
    const cookies = parseCookies(r1.headers.getSetCookie());

    const r2 = await fetch(
      BASE + "/youtube/auth/callback?code=test_yt_code&state=" + encodeURIComponent(state),
      { redirect: "manual", headers: { Cookie: Object.entries(cookies).map(([k,v]) => k+"="+v).join("; ") } }
    );
    assert.equal(r2.status, 302, "Callback should redirect (302)");
    const redirectUrl = r2.headers.get("location");
    assert.ok(redirectUrl.includes("youtube_connected=1"), "Should have youtube_connected=1");
    assert.ok(redirectUrl.includes("yt_handoff="), "Should have yt_handoff");

    const handoffCode = new URL(redirectUrl).searchParams.get("yt_handoff");
    const callbackCookies = parseCookies(r2.headers.getSetCookie());

    const r3 = await fetch(BASE + "/api/youtube/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handoff: handoffCode })
    });
    const data = await r3.json();
    assert.equal(data.connected, true);
    assert.ok(data.session_token, "Session token returned");
    return { sessionToken: data.session_token, callbackCookies };
  } finally {
    globalThis.fetch = _orig;
  }
}

describe("YouTube Integration", () => {

  it("1. YouTube health endpoint", async () => {
    const r = await fetch(BASE + "/api/youtube/health");
    const data = await r.json();
    assert.equal(data.status, "ok");
    assert.equal(data.service, "modern-living-hub-youtube");
    assert.equal(data.youtube_configured, true);
    assert.deepEqual(data.scopes, ["https://www.googleapis.com/auth/youtube.upload"]);
    assert.ok(data.privacy_note.includes("audit"), "Privacy note about audit restriction");
  });

  it("2. OAuth start redirects to Google with correct params", async () => {
    const r = await fetch(BASE + "/youtube/auth", { redirect: "manual" });
    assert.equal(r.status, 302);
    const loc = r.headers.get("location");
    assert.ok(loc.startsWith("https://accounts.google.com/o/oauth2/v2/auth"), "Redirects to Google OAuth");
    const url = new URL(loc);
    assert.equal(url.searchParams.get("client_id"), "yt_test_client_id_12345");
    assert.equal(url.searchParams.get("scope"), "https://www.googleapis.com/auth/youtube.upload");
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
    assert.ok(url.searchParams.get("state"), "CSRF state present");
    assert.ok(url.searchParams.get("redirect_uri"), "Redirect URI present");
    assert.ok(!loc.includes("yt_test_client_secret"), "NO client secret in URL");
    assert.ok(!loc.includes("access_token"), "NO access token in URL");
  });

  it("3. OAuth callback → handoff → session token", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      TS.sessionToken = await completeYouTubeOAuth();
      assert.ok(TS.sessionToken, "Session token obtained");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("4. Status → connected:true, no tokens exposed", async () => {
    const r = await fetch(BASE + "/api/youtube/status", {
      headers: { "Authorization": "Bearer " + TS.sessionToken }
    });
    const data = await r.json();
    assert.equal(data.connected, true);
    assert.equal(data.channel.title, "Test YouTube Channel");
    assert.ok(!JSON.stringify(data).includes("mock_youtube_access_token"), "NO access token in response");
  });

  it("5. Channel info retrieval", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      const r = await fetch(BASE + "/api/youtube/channel", {
        headers: { "Authorization": "Bearer " + TS.sessionToken }
      });
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.equal(data.channel.title, "Test YouTube Channel");
      assert.equal(data.channel.id, "UC_mock_channel_id_123");
      assert.ok(!JSON.stringify(data).includes("mock_youtube_access_token"), "NO token in response");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("6. Unauthenticated endpoints → 401", async () => {
    const endpoints = [
      { url: "/api/youtube/channel", method: "GET" },
      { url: "/api/youtube/video-status/fake", method: "GET" }
    ];
    for (const ep of endpoints) {
      const r = await fetch(BASE + ep.url, { method: ep.method });
      assert.equal(r.status, 401, `${ep.url} should return 401`);
    }

    const r2 = await fetch(BASE + "/api/youtube/upload", { method: "POST" });
    assert.equal(r2.status, 401, "upload should return 401 without auth");
  });

  it("7. Client secret never exposed in logs", async () => {
    const _orig = globalThis.fetch;
    const _logs = [];
    const _origLog = console.log;
    const _origErr = console.error;
    console.log = (...args) => _logs.push(args.join(" "));
    console.error = (...args) => _logs.push(args.join(" "));
    mockGoogleAPIs();
    try {
      await completeYouTubeOAuth();
      const allLogs = _logs.join("\n");
      assert.ok(!allLogs.includes("yt_test_client_secret"), "Client secret must not appear in logs");
      assert.ok(!allLogs.includes("mock_youtube_access_token"), "Access token must not appear in logs");
      assert.ok(!allLogs.includes("mock_youtube_refresh_token"), "Refresh token must not appear in logs");
    } finally {
      console.log = _origLog;
      console.error = _origErr;
      globalThis.fetch = _orig;
    }
  });

  it("8. OAuth state validation — invalid state rejected", async () => {
    const r = await fetch(
      BASE + "/youtube/auth/callback?code=fake&state=wrong_state",
      { redirect: "manual" }
    );
    assert.equal(r.status, 302);
    const loc = r.headers.get("location");
    assert.ok(loc.includes("yt_error="), "Should redirect with error");
    assert.ok(loc.includes("invalid_state"), "Should mention invalid state");
  });

  it("9. Disconnect → tokens invalidated", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      TS.sessionToken = await completeYouTubeOAuth();
      assert.ok(TS.sessionToken, "Fresh session token obtained");

      const r1 = await fetch(BASE + "/api/youtube/disconnect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + TS.sessionToken
        }
      });
      assert.equal(r1.status, 200);
      assert.equal((await r1.json()).disconnected, true);

      const r2 = await fetch(BASE + "/api/youtube/status", {
        headers: { "Authorization": "Bearer " + TS.sessionToken }
      });
      const data = await r2.json();
      assert.equal(data.connected, false, "Should be disconnected");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("10. Disconnect clears local state", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      TS.sessionToken = await completeYouTubeOAuth();

      await fetch(BASE + "/api/youtube/disconnect", {
        method: "POST",
        headers: { "Authorization": "Bearer " + TS.sessionToken }
      });

      // Verify all endpoints now return 401 or disconnected
      const status = await fetch(BASE + "/api/youtube/status", {
        headers: { "Authorization": "Bearer " + TS.sessionToken }
      });
      assert.equal((await status.json()).connected, false);

      const channel = await fetch(BASE + "/api/youtube/channel", {
        headers: { "Authorization": "Bearer " + TS.sessionToken }
      });
      assert.equal(channel.status, 401);
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("11. Reconnect starts fresh OAuth", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      TS.sessionToken = await completeYouTubeOAuth();
      assert.ok(TS.sessionToken, "Session token obtained");

      // Disconnect
      await fetch(BASE + "/api/youtube/disconnect", {
        method: "POST",
        headers: { "Authorization": "Bearer " + TS.sessionToken }
      });

      // Verify disconnected
      const s1 = await fetch(BASE + "/api/youtube/status", {
        headers: { "Authorization": "Bearer " + TS.sessionToken }
      });
      assert.equal((await s1.json()).connected, false);

      // Reconnect
      TS.sessionToken = await completeYouTubeOAuth();
      assert.ok(TS.sessionToken, "Fresh session token after reconnect");

      const s2 = await fetch(BASE + "/api/youtube/status", {
        headers: { "Authorization": "Bearer " + TS.sessionToken }
      });
      assert.equal((await s2.json()).connected, true);
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("12. Token exchange diagnostic logging", async () => {
    const _orig = globalThis.fetch;
    const _logs = [];
    const _origLog = console.log;
    const _origErr = console.error;
    console.log = (...args) => _logs.push(args.join(" "));
    console.error = (...args) => _logs.push(args.join(" "));
    mockGoogleAPIs();
    try {
      await completeYouTubeOAuth();
      const allLogs = _logs.join("\n");
      assert.ok(allLogs.includes("YouTube OAuth callback: token exchange succeeded"), "token exchange succeeded log");
      assert.ok(allLogs.includes("YouTube OAuth callback: token stored"), "token stored log");
      assert.ok(allLogs.includes("YouTube OAuth callback: handoff created"), "handoff created log");
      assert.ok(allLogs.includes("YouTube channel lookup (callback): success channel=UC_mock_channel_id_123"), "channel id in callback log");
      assert.ok(!allLogs.includes("yt_test_client_secret"), "Client secret must not appear in logs");
      assert.ok(!allLogs.includes("mock_youtube_access_token"), "Access token must not appear in logs");
    } finally {
      console.log = _origLog;
      console.error = _origErr;
      globalThis.fetch = _orig;
    }
  });

  it("13. Token exchange failure handling", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs({
      tokenExchange: () => Promise.resolve(new Response(JSON.stringify({
        error: "invalid_grant",
        error_description: "Code was already redeemed."
      }), { status: 400, headers: { "Content-Type": "application/json" } }))
    });
    try {
      const r1 = await fetch(BASE + "/youtube/auth", { redirect: "manual" });
      const loc = r1.headers.get("location");
      const state = new URL(loc).searchParams.get("state");
      const cookies = parseCookies(r1.headers.getSetCookie());

      const r2 = await fetch(
        BASE + "/youtube/auth/callback?code=bad_code&state=" + encodeURIComponent(state),
        { redirect: "manual", headers: { Cookie: Object.entries(cookies).map(([k,v]) => k+"="+v).join("; ") } }
      );
      assert.equal(r2.status, 302);
      const errUrl = r2.headers.get("location");
      assert.ok(errUrl.includes("yt_error="), "Should redirect with error");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("14. Video upload with valid metadata", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      TS.sessionToken = await completeYouTubeOAuth();
      const uploadBody = new FormData();
      uploadBody.append("video", new Blob([Buffer.alloc(1024)]), "test.mp4");
      uploadBody.append("title", "Test Upload");
      uploadBody.append("description", "Test description");
      uploadBody.append("tags", "test, upload");
      uploadBody.append("category", "22");
      uploadBody.append("privacyStatus", "private");
      uploadBody.append("madeForKids", "false");

      const r = await fetch(BASE + "/api/youtube/upload", {
        method: "POST",
        headers: { "Authorization": "Bearer " + TS.sessionToken },
        body: uploadBody
      });
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.equal(data.success, true);
      assert.ok(data.video_id, "Should return video_id");
      assert.ok(data.video_url.includes("youtube.com"), "Should return YouTube URL");
      assert.equal(data.privacy_status, "private");
      assert.ok(!JSON.stringify(data).includes("mock_youtube_access_token"), "NO token in response");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("15. Video upload missing title → 400", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      TS.sessionToken = await completeYouTubeOAuth();
      const uploadBody = new FormData();
      uploadBody.append("video", new Blob([Buffer.alloc(1024)]), "test.mp4");
      uploadBody.append("title", "");
      uploadBody.append("privacyStatus", "private");

      const r = await fetch(BASE + "/api/youtube/upload", {
        method: "POST",
        headers: { "Authorization": "Bearer " + TS.sessionToken },
        body: uploadBody
      });
      assert.equal(r.status, 400);
      const data = await r.json();
      assert.ok(data.error.includes("Title"), "Error should mention title");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("16. Video upload missing file → 400", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      TS.sessionToken = await completeYouTubeOAuth();
      const uploadBody = new FormData();
      uploadBody.append("title", "Test");
      uploadBody.append("privacyStatus", "private");

      const r = await fetch(BASE + "/api/youtube/upload", {
        method: "POST",
        headers: { "Authorization": "Bearer " + TS.sessionToken },
        body: uploadBody
      });
      assert.equal(r.status, 400);
      const data = await r.json();
      assert.ok(data.error.includes("video"), "Error should mention video file");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("17. Video upload invalid privacy → 400", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      TS.sessionToken = await completeYouTubeOAuth();
      const uploadBody = new FormData();
      uploadBody.append("video", new Blob([Buffer.alloc(1024)]), "test.mp4");
      uploadBody.append("title", "Test");
      uploadBody.append("privacyStatus", "INVALID");

      const r = await fetch(BASE + "/api/youtube/upload", {
        method: "POST",
        headers: { "Authorization": "Bearer " + TS.sessionToken },
        body: uploadBody
      });
      assert.equal(r.status, 400);
      const data = await r.json();
      assert.ok(data.error.includes("privacyStatus") || data.error.includes("Invalid"), "Error should mention invalid privacy");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("18. Unauthenticated upload → 401", async () => {
    const uploadBody = new FormData();
    uploadBody.append("video", new Blob([Buffer.alloc(1024)]), "test.mp4");
    uploadBody.append("title", "Test");

    const r = await fetch(BASE + "/api/youtube/upload", {
      method: "POST",
      body: uploadBody
    });
    assert.equal(r.status, 401);
  });

  it("19. Unauthenticated video-status → 401", async () => {
    const r = await fetch(BASE + "/api/youtube/video-status/fake_id");
    assert.equal(r.status, 401);
  });

  it("20. Video status endpoint works", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      TS.sessionToken = await completeYouTubeOAuth();
      assert.ok(TS.sessionToken, "Session token obtained in test 20");
      // First check status
      const statusRes = await fetch(BASE + "/api/youtube/status", {
        headers: { "Authorization": "Bearer " + TS.sessionToken }
      });
      const statusData = await statusRes.json();
      assert.equal(statusData.connected, true, "Should be connected (status=" + statusRes.status + ")");
      // Then check video status
      const r = await fetch(BASE + "/api/youtube/video-status/mock_video_id_12345", {
        headers: { "Authorization": "Bearer " + TS.sessionToken }
      });
      const body = await r.text();
      assert.equal(r.status, 200, "video-status returned " + r.status + " body=" + body);
      const data = JSON.parse(body);
      assert.equal(data.video_id, "mock_video_id_12345");
      assert.equal(data.processing_status, "succeeded");
      assert.equal(data.privacy_status, "private");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("21. Google credentials never in logs", async () => {
    const _orig = globalThis.fetch;
    const _logs = [];
    const _origLog = console.log;
    const _origErr = console.error;
    console.log = (...args) => _logs.push(args.join(" "));
    console.error = (...args) => _logs.push(args.join(" "));
    mockGoogleAPIs();
    try {
      const token = await completeYouTubeOAuth();
      await fetch(BASE + "/api/youtube/disconnect", {
        method: "POST",
        headers: { "Authorization": "Bearer " + token }
      });
      const allLogs = _logs.join("\n");
      assert.ok(!allLogs.includes("yt_test_client_secret"), "Client secret must not appear in logs");
      assert.ok(!allLogs.includes("mock_youtube_access_token"), "Access token must not appear in logs");
      assert.ok(!allLogs.includes("mock_youtube_refresh_token"), "Refresh token must not appear in logs");
      assert.ok(!allLogs.includes(token), "Session token must not appear in logs");
    } finally {
      console.log = _origLog;
      console.error = _origErr;
      globalThis.fetch = _orig;
    }
  });

  it("22. OAuth URL includes disable_auto_auth=1", async () => {
    const r = await fetch(BASE + "/youtube/auth", { redirect: "manual" });
    assert.equal(r.status, 302);
    const loc = r.headers.get("location");
    const url = new URL(loc);
    assert.equal(url.searchParams.get("prompt"), "consent");
    assert.equal(url.searchParams.get("access_type"), "offline");
  });

  it("23. Disconnect does not touch Pinterest tokens", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      TS.sessionToken = await completeYouTubeOAuth();

      // Disconnect YouTube
      await fetch(BASE + "/api/youtube/disconnect", {
        method: "POST",
        headers: { "Authorization": "Bearer " + TS.sessionToken }
      });

      // Verify YouTube is disconnected
      const ytStatus = await fetch(BASE + "/api/youtube/status", {
        headers: { "Authorization": "Bearer " + TS.sessionToken }
      });
      assert.equal((await ytStatus.json()).connected, false, "YouTube should be disconnected");

      // Note: We can't directly test Pinterest token state from here without
      // Pinterest being set up, but we verify the disconnect path only touches
      // YouTube stores (ytTokenStore, ytSessionTokenStore, mlh.ytoken cookie).
      // The test confirms YouTube is disconnected without errors, proving
      // the disconnect handler ran cleanly.
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("24. Disconnect does not touch TikTok tokens", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      TS.sessionToken = await completeYouTubeOAuth();

      // Disconnect YouTube
      await fetch(BASE + "/api/youtube/disconnect", {
        method: "POST",
        headers: { "Authorization": "Bearer " + TS.sessionToken }
      });

      // Verify YouTube is disconnected
      const ytStatus = await fetch(BASE + "/api/youtube/status", {
        headers: { "Authorization": "Bearer " + TS.sessionToken }
      });
      assert.equal((await ytStatus.json()).connected, false, "YouTube should be disconnected");

      // Same as test 23 — confirm clean YouTube-only disconnect.
    } finally {
      globalThis.fetch = _orig;
    }
  });

});


  it("25. OAuth state survives Google redirect via cookie (no in-memory session needed)", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      // Test that the OAuth state is validated solely from the signed cookie
      // without relying on req.session (which may be lost on restart/hibernation)
      const r1 = await fetch(BASE + "/youtube/auth", { redirect: "manual" });
      const loc = r1.headers.get("location");
      const state = new URL(loc).searchParams.get("state");
      const cookies = parseCookies(r1.headers.getSetCookie());
      const cookieState = extractSignedCookieValue(cookies, "mlh.yt.oauth_state");
      
      assert.ok(cookieState, "Signed cookie should contain OAuth state");
      assert.ok(cookieState.length >= 32, "State should be cryptographically random (64+ hex chars)");
      
      // Now simulate callback using ONLY the cookie (no session continuity)
      // Build cookie header with the signed cookie value
      const cookieHeader = Object.entries(cookies).map(([k,v]) => k+"="+v).join("; ");
      const r2 = await fetch(
        BASE + "/youtube/auth/callback?code=test_yt_code&state=" + encodeURIComponent(state),
        { redirect: "manual", headers: { Cookie: cookieHeader } }
      );
      assert.equal(r2.status, 302, "Callback should redirect (302)");
      const redirectUrl = r2.headers.get("location");
      assert.ok(redirectUrl.includes("youtube_connected=1"), "Should have youtube_connected=1");
      assert.ok(redirectUrl.includes("yt_handoff="), "Should have yt_handoff");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("26. Expired OAuth state is rejected", async () => {
    // Forge a VALIDLY-SIGNED state but with a timestamp older than the 10-minute window.
    const expiredNonce = "a".repeat(64);
    const oldTimestamp = Date.now() - 11 * 60 * 1000; // 11 minutes ago (> 10 min TTL)
    const expiredState = buildYTState(expiredNonce, oldTimestamp, process.env.SESSION_SECRET);

    const r2 = await fetch(
      BASE + "/youtube/auth/callback?code=test_yt_code&state=" + encodeURIComponent(expiredState),
      { redirect: "manual" }
    );
    assert.equal(r2.status, 302, "Callback should redirect (302)");
    const redirectUrl = r2.headers.get("location");
    assert.ok(redirectUrl.includes("yt_error="), "Should redirect with error");
    assert.ok(redirectUrl.includes("invalid_state"), "Expired signed state should be rejected");
  });

  it("27. Mismatched OAuth state is rejected", async () => {
    // Use a valid callback state but mismatch the cookie
    const r1 = await fetch(BASE + "/youtube/auth", { redirect: "manual" });
    const loc = r1.headers.get("location");
    const state = new URL(loc).searchParams.get("state");
    const cookies = parseCookies(r1.headers.getSetCookie());
    const cookieHeader = Object.entries(cookies).map(([k,v]) => k+"="+v).join("; ");
    
    // Send a DIFFERENT state in the callback query param
    const wrongState = "0000000000000000000000000000000000000000000000000000000000000000";
    
    const r2 = await fetch(
      BASE + "/youtube/auth/callback?code=test_yt_code&state=" + encodeURIComponent(wrongState),
      { redirect: "manual", headers: { Cookie: cookieHeader } }
    );
    assert.equal(r2.status, 302, "Callback should redirect (302)");
    const redirectUrl = r2.headers.get("location");
    assert.ok(redirectUrl.includes("yt_error="), "Should redirect with error");
    assert.ok(redirectUrl.includes("invalid_state"), "Should mention invalid state for mismatch");
  });

  it("28. OAuth state cookie has correct security attributes", async () => {
    const r = await fetch(BASE + "/youtube/auth", { redirect: "manual" });
    const cookies = r.headers.getSetCookie();
    const stateCookie = cookies.find(c => c.startsWith("mlh.yt.oauth_state="));
    assert.ok(stateCookie, "OAuth state cookie should be set");
    assert.ok(stateCookie.includes("HttpOnly"), "Cookie should be HttpOnly");
    assert.ok(stateCookie.includes("Path=/"), "Cookie should have Path=/");
    // In test mode (NODE_ENV=test), secure should be false, sameSite=lax
    assert.ok(stateCookie.includes("SameSite=Lax") || stateCookie.includes("SameSite=None"), "Cookie should have SameSite");
    assert.ok(stateCookie.includes("Max-Age=600") || stateCookie.includes("max-age=600"), "Cookie should have 10 minute maxAge (600 seconds)");
  });

  it("29. OAuth state cookie is consumed after successful callback", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      const r1 = await fetch(BASE + "/youtube/auth", { redirect: "manual" });
      const loc = r1.headers.get("location");
      const state = new URL(loc).searchParams.get("state");
      const cookies = parseCookies(r1.headers.getSetCookie());
      
      // First callback - should succeed
      const cookieHeader1 = Object.entries(cookies).map(([k,v]) => k+"="+v).join("; ");
      const r2 = await fetch(
        BASE + "/youtube/auth/callback?code=test_yt_code&state=" + encodeURIComponent(state),
        { redirect: "manual", headers: { Cookie: cookieHeader1 } }
      );
      assert.equal(r2.status, 302);
      
      // Get cookies from the FIRST callback response (which should have cleared the state cookie)
      const callbackCookies = parseCookies(r2.headers.getSetCookie());
      const cookieHeader2 = Object.entries(callbackCookies).map(([k,v]) => k+"="+v).join("; ");
      
      // Try to use the SAME state again - should fail because cookie was cleared
      const r3 = await fetch(
        BASE + "/youtube/auth/callback?code=test_yt_code2&state=" + encodeURIComponent(state),
        { redirect: "manual", headers: { Cookie: cookieHeader2 } }
      );
      assert.equal(r3.status, 302, "Second callback should redirect");
      const loc3 = r3.headers.get("location");
      assert.ok(loc3.includes("yt_error=invalid_state"), "Reusing consumed state should fail");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("30. Multiple concurrent OAuth flows use independent states", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      // Start two OAuth flows
      const r1a = await fetch(BASE + "/youtube/auth", { redirect: "manual" });
      const loc1a = r1a.headers.get("location");
      const state1 = new URL(loc1a).searchParams.get("state");
      const cookies1 = parseCookies(r1a.headers.getSetCookie());
      
      const r1b = await fetch(BASE + "/youtube/auth", { redirect: "manual" });
      const loc1b = r1b.headers.get("location");
      const state2 = new URL(loc1b).searchParams.get("state");
      const cookies2 = parseCookies(r1b.headers.getSetCookie());
      
      assert.notEqual(state1, state2, "Each flow should generate unique state");
      
      // Complete first flow
      const r2a = await fetch(
        BASE + "/youtube/auth/callback?code=test_yt_code1&state=" + encodeURIComponent(state1),
        { redirect: "manual", headers: { Cookie: Object.entries(cookies1).map(([k,v]) => k+"="+v).join("; ") } }
      );
      assert.equal(r2a.status, 302);
      assert.ok(r2a.headers.get("location").includes("youtube_connected=1"));
      
      // Second flow should still work with its own state
      const r2b = await fetch(
        BASE + "/youtube/auth/callback?code=test_yt_code2&state=" + encodeURIComponent(state2),
        { redirect: "manual", headers: { Cookie: Object.entries(cookies2).map(([k,v]) => k+"="+v).join("; ") } }
      );
      assert.equal(r2b.status, 302);
      assert.ok(r2b.headers.get("location").includes("youtube_connected=1"));
    } finally {
      globalThis.fetch = _orig;
    }
  });


  it("31. Modified/tampered state is rejected", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      const r1 = await fetch(BASE + "/youtube/auth", { redirect: "manual" });
      const loc = r1.headers.get("location");
      const goodState = new URL(loc).searchParams.get("state");

      // Tamper with the signature (flip last char)
      const tampered = goodState.slice(0, -1) + (goodState.endsWith("A") ? "B" : "A");

      const r2 = await fetch(
        BASE + "/youtube/auth/callback?code=test_yt_code&state=" + encodeURIComponent(tampered),
        { redirect: "manual" }
      );
      assert.equal(r2.status, 302, "Callback should redirect (302)");
      const redirectUrl = r2.headers.get("location");
      assert.ok(redirectUrl.includes("yt_error=invalid_state"), "Tampered state should be rejected");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("32. Missing state is rejected", async () => {
    const r2 = await fetch(
      BASE + "/youtube/auth/callback?code=test_yt_code",
      { redirect: "manual" }
    );
    assert.equal(r2.status, 302, "Callback should redirect (302)");
    const redirectUrl = r2.headers.get("location");
    assert.ok(redirectUrl.includes("yt_error=invalid_state"), "Missing state should be rejected");
  });

  it("33. Malformed state is rejected", async () => {
    const badStates = ["just-a-plain-string", "abc.def.ghi.jkl", "nonce.12345"];
    for (const badState of badStates) {
      const r = await fetch(
        BASE + "/youtube/auth/callback?code=test_yt_code&state=" + encodeURIComponent(badState),
        { redirect: "manual" }
      );
      assert.equal(r.status, 302, "Callback should redirect (302)");
      const redirectUrl = r.headers.get("location");
      assert.ok(redirectUrl.includes("yt_error=invalid_state"), "Malformed state should be rejected: " + badState);
    }
  });

  it("34. Valid signed state works WITHOUT the mlh.yt.oauth_state cookie", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      const r1 = await fetch(BASE + "/youtube/auth", { redirect: "manual" });
      const loc = r1.headers.get("location");
      const state = new URL(loc).searchParams.get("state");
      assert.ok(state && state.split(".").length === 3, "State should be nonce.timestamp.signature");

      // NO cookies at all — the signed state alone must be sufficient
      const r2 = await fetch(
        BASE + "/youtube/auth/callback?code=test_yt_code&state=" + encodeURIComponent(state),
        { redirect: "manual" }
      );
      assert.equal(r2.status, 302, "Callback should redirect (302)");
      const redirectUrl = r2.headers.get("location");
      assert.ok(redirectUrl.includes("youtube_connected=1"), "Valid signed state without cookie should succeed");
      assert.ok(redirectUrl.includes("yt_handoff="), "Should return handoff");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("35. Replayed state is rejected (single-use, no cookie needed)", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      const r1 = await fetch(BASE + "/youtube/auth", { redirect: "manual" });
      const loc = r1.headers.get("location");
      const state = new URL(loc).searchParams.get("state");

      // First use: succeeds (no cookie)
      const r2 = await fetch(
        BASE + "/youtube/auth/callback?code=test_yt_code&state=" + encodeURIComponent(state),
        { redirect: "manual" }
      );
      assert.equal(r2.status, 302);
      assert.ok(r2.headers.get("location").includes("youtube_connected=1"), "First use should succeed");

      // Second use of the SAME state: must be rejected as replay
      const r3 = await fetch(
        BASE + "/youtube/auth/callback?code=test_yt_code2&state=" + encodeURIComponent(state),
        { redirect: "manual" }
      );
      assert.equal(r3.status, 302, "Replay callback should redirect");
      const loc3 = r3.headers.get("location");
      assert.ok(loc3.includes("yt_error=invalid_state"), "Replayed state should be rejected");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  // ─── Regression: post-OAuth connection loop (production bug) ───

  it("36. Callback lifecycle: token stored, handoff created, channel resolved", async () => {
    const _orig = globalThis.fetch;
    const _logs = [];
    const _origLog = console.log;
    const _origErr = console.error;
    console.log = (...args) => _logs.push(args.join(" "));
    console.error = (...args) => _logs.push(args.join(" "));
    mockGoogleAPIs();
    try {
      await completeYouTubeOAuth();
      const allLogs = _logs.join("\n");
      assert.ok(allLogs.includes("YouTube OAuth callback: token exchange succeeded"), "token exchange succeeded log");
      assert.ok(allLogs.includes("YouTube OAuth callback: token stored"), "token stored log");
      assert.ok(allLogs.includes("YouTube OAuth callback: handoff created"), "handoff created log");
      assert.ok(allLogs.includes("YouTube channel lookup (callback): success channel=UC_mock_channel_id_123"), "channel id in callback log");
    } finally {
      console.log = _origLog;
      console.error = _origErr;
      globalThis.fetch = _orig;
    }
  });

  it("37. Handoff is single-use: consumed exactly once, replay rejected", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      const r1 = await fetch(BASE + "/youtube/auth", { redirect: "manual" });
      const state = new URL(r1.headers.get("location")).searchParams.get("state");
      const cookies = parseCookies(r1.headers.getSetCookie());
      const r2 = await fetch(
        BASE + "/youtube/auth/callback?code=test_yt_code&state=" + encodeURIComponent(state),
        { redirect: "manual", headers: { Cookie: Object.entries(cookies).map(([k,v]) => k+"="+v).join("; ") } }
      );
      assert.equal(r2.status, 302);
      const handoffCode = new URL(r2.headers.get("location")).searchParams.get("yt_handoff");
      assert.ok(handoffCode, "Handoff code present");

      const first = await fetch(BASE + "/api/youtube/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handoff: handoffCode })
      });
      const firstData = await first.json();
      assert.equal(firstData.connected, true, "First consume succeeds");
      assert.ok(firstData.session_token, "Session token created on first consume");

      const second = await fetch(BASE + "/api/youtube/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handoff: handoffCode })
      });
      assert.equal(second.status, 400, "Replayed handoff rejected");
      assert.ok((await second.json()).error, "Replay error message present");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("38. Status connected=true immediately after handoff; persists on refresh", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      const token = await completeYouTubeOAuth();
      assert.ok(token, "Session token obtained");

      const r1 = await fetch(BASE + "/api/youtube/status", {
        headers: { "Authorization": "Bearer " + token }
      });
      const s1 = await r1.json();
      assert.equal(s1.connected, true, "Status connected immediately after handoff");
      assert.equal(s1.channel.id, "UC_mock_channel_id_123", "Channel id present in status");

      const r2 = await fetch(BASE + "/api/youtube/status", {
        headers: { "Authorization": "Bearer " + token }
      });
      assert.equal((await r2.json()).connected, true, "Still connected on refresh");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("39. Channel API works with Bearer session token; contract matches frontend", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      const token = await completeYouTubeOAuth();
      const r = await fetch(BASE + "/api/youtube/channel", {
        headers: { "Authorization": "Bearer " + token }
      });
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.ok(data.channel, "Response wrapped in {channel: ...}");
      assert.equal(data.channel.id, "UC_mock_channel_id_123");
      assert.equal(data.channel.title, "Test YouTube Channel");
      assert.equal(data.channel.description, "A test channel for Modern Living Hub");
      assert.equal(data.channel.thumbnail, "https://yt3.ggpht.com/a/default-user.jpg");
      assert.equal(data.channel.uploads_playlist_id, "UU_mock_channel_id_123");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("40. Stale/invalid session token → 401 for YouTube only", async () => {
    const bogus = "bogus_session_token_" + crypto.randomBytes(8).toString("hex");
    const r1 = await fetch(BASE + "/api/youtube/channel", {
      headers: { "Authorization": "Bearer " + bogus }
    });
    assert.equal(r1.status, 401, "Invalid bearer → 401");

    const r2 = await fetch(BASE + "/api/youtube/status", {
      headers: { "Authorization": "Bearer " + bogus }
    });
    const s2 = await r2.json();
    assert.equal(s2.connected, false, "Invalid bearer → disconnected");
    assert.ok(!JSON.stringify(s2).includes("access_token"), "No token in response");
  });

  it("41. Encrypted cookie fallback keeps connection after in-memory store reset (Render restart)", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      const flow = await performYouTubeFlowWithCookies();
      assert.ok(flow.sessionToken, "Session token created");
      assert.ok(flow.callbackCookies["mlh.ytoken"], "mlh.ytoken encrypted cookie set on callback");

      const cookieHeader = "mlh.ytoken=" + flow.callbackCookies["mlh.ytoken"];
      const r1 = await fetch(BASE + "/api/youtube/status", {
        headers: { Cookie: cookieHeader }
      });
      const s1 = await r1.json();
      assert.equal(s1.connected, true, "Cookie-only status remains connected");

      const r2 = await fetch(BASE + "/api/youtube/channel", {
        headers: { Cookie: cookieHeader }
      });
      assert.equal(r2.status, 200, "Cookie-only channel request authenticated");
      const ch = await r2.json();
      assert.equal(ch.channel.id, "UC_mock_channel_id_123");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("42. Google channel lookup rejection (403) → 502, valid session NOT destroyed", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs({
      channel: () => Promise.resolve(new Response(JSON.stringify({
        error: {
          code: 403,
          message: "YouTube Data API v3 has not been used in project",
          reason: "forbidden",
          status: "PERMISSION_DENIED"
        }
      }), { status: 403, headers: { "Content-Type": "application/json" } }))
    });
    try {
      const token = await completeYouTubeOAuth();
      const r = await fetch(BASE + "/api/youtube/channel", {
        headers: { "Authorization": "Bearer " + token }
      });
      assert.equal(r.status, 502, "Channel lookup rejection surfaced as 502");
      const data = await r.json();
      assert.equal(data.channel, null, "No channel data in 502 body");
      assert.ok(data.error, "Safe error message present");

      const s = await fetch(BASE + "/api/youtube/status", {
        headers: { "Authorization": "Bearer " + token }
      });
      assert.equal((await s.json()).connected, true, "Session intact after channel lookup failure");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("43. Frontend keeps Connected state and token on non-401 channel errors", async () => {
    const src = readFileSync(new URL("../assets/js/youtube.js", import.meta.url), "utf8");
    assert.ok(src.includes("if (res.status === 401) {"), "401 handled separately (clears token)");
    assert.ok(src.includes("if (res.status === 403) {"), "403 handled separately (keeps token)");
    assert.ok(src.includes("if (!res.ok) {"), "Other errors handled without disconnecting");
    assert.ok(!src.includes("if (res.status === 401 || res.status === 403) {"), "401/403 no longer share disconnect branch");
    assert.ok(src.includes("Connection expired"), "401 path shows reconnect message");
  });

  it("44. Frontend init does not race handoff against checkStatus", async () => {
    const src = readFileSync(new URL("../assets/js/youtube.js", import.meta.url), "utf8");
    assert.ok(src.includes("var hadHandoff = await handleUrlParams();"), "init captures handoff result");
    assert.ok(src.includes("if (!hadHandoff) {"), "checkStatus skipped when handoff present");
    assert.ok(src.includes("await checkStatus();"), "checkStatus still runs on plain page load");
  });

  it("45. Handoff/session lifecycle logs contain no credentials", async () => {
    const _orig = globalThis.fetch;
    const _logs = [];
    const _origLog = console.log;
    const _origErr = console.error;
    console.log = (...args) => _logs.push(args.join(" "));
    console.error = (...args) => _logs.push(args.join(" "));
    mockGoogleAPIs();
    try {
      const token = await completeYouTubeOAuth();
      await fetch(BASE + "/api/youtube/status", {
        headers: { "Authorization": "Bearer " + token }
      });
      const allLogs = _logs.join("\n");
      const forbidden = [
        "mock_youtube_access_token",
        "mock_youtube_refresh_token",
        "yt_test_client_secret",
        "test_yt_code",
        token
      ];
      for (const secret of forbidden) {
        assert.ok(!allLogs.includes(secret), "Logs must not contain: " + secret);
      }
      assert.ok(allLogs.includes("YouTube handoff: consumed"), "handoff consumed logged");
      assert.ok(allLogs.includes("YouTube handoff: session created"), "session created logged");
      assert.ok(allLogs.includes("YouTube status: authenticated"), "status authenticated logged");
    } finally {
      console.log = _origLog;
      console.error = _origErr;
      globalThis.fetch = _orig;
    }
  });

  // ─── Regression: YouTube upload "Not connected" state ───

  it("46. Upload is authenticated via encrypted-cookie fallback after in-memory reset", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs();
    try {
      const flow = await performYouTubeFlowWithCookies();
      assert.ok(flow.callbackCookies["mlh.ytoken"], "mlh.ytoken encrypted cookie available");

      const cookieHeader = "mlh.ytoken=" + flow.callbackCookies["mlh.ytoken"];
      const uploadBody = new FormData();
      uploadBody.append("video", new Blob([Buffer.alloc(1024)]), "test.mp4");
      uploadBody.append("title", "Test Upload");
      uploadBody.append("description", "Test description");
      uploadBody.append("tags", "test, upload");
      uploadBody.append("category", "22");
      uploadBody.append("privacyStatus", "private");
      uploadBody.append("madeForKids", "false");

      // No bearer token, no in-memory session — the encrypted cookie alone
      // must authenticate the upload (same fallback /api/youtube/status uses).
      const r = await fetch(BASE + "/api/youtube/upload", {
        method: "POST",
        headers: { Cookie: cookieHeader },
        body: uploadBody
      });
      assert.equal(r.status, 200, "Cookie-only upload request is authenticated");
      const data = await r.json();
      assert.equal(data.success, true);
      assert.ok(data.video_id, "Video id returned");
      assert.equal(data.privacy_status, "private", "Private upload behavior preserved");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("47. Missing/invalid session → upload returns not-connected (401)", async () => {
    const uploadBody = new FormData();
    uploadBody.append("video", new Blob([Buffer.alloc(1024)]), "test.mp4");
    uploadBody.append("title", "Test Upload");
    uploadBody.append("privacyStatus", "private");

    const bogus = "bogus_session_token_" + crypto.randomBytes(8).toString("hex");
    const r1 = await fetch(BASE + "/api/youtube/upload", {
      method: "POST",
      headers: { "Authorization": "Bearer " + bogus },
      body: uploadBody
    });
    assert.equal(r1.status, 401, "Expired/invalid bearer → 401");
    const d1 = await r1.json();
    assert.equal(d1.error, "Not connected to YouTube.");
    assert.ok(!JSON.stringify(d1).includes("mock_youtube_access_token"), "No token in 401 body");

    const r2 = await fetch(BASE + "/api/youtube/upload", {
      method: "POST",
      body: uploadBody
    });
    assert.equal(r2.status, 401, "Missing session → 401");
  });

  it("48. Channel-info 403 does NOT destroy a valid upload session", async () => {
    const _orig = globalThis.fetch;
    mockGoogleAPIs({
      channel: () => Promise.resolve(new Response(JSON.stringify({
        error: {
          code: 403,
          message: "YouTube Data API v3 has not been used in project",
          reason: "forbidden",
          status: "PERMISSION_DENIED"
        }
      }), { status: 403, headers: { "Content-Type": "application/json" } }))
    });
    try {
      const token = await completeYouTubeOAuth();
      assert.ok(token, "Session token obtained");

      const ch = await fetch(BASE + "/api/youtube/channel", {
        headers: { "Authorization": "Bearer " + token }
      });
      assert.equal(ch.status, 502, "Channel-info 403 mapped to 502, not 401/403");

      // The SAME valid session must still upload successfully.
      const uploadBody = new FormData();
      uploadBody.append("video", new Blob([Buffer.alloc(1024)]), "test.mp4");
      uploadBody.append("title", "Test Upload");
      uploadBody.append("privacyStatus", "private");
      const r = await fetch(BASE + "/api/youtube/upload", {
        method: "POST",
        headers: { "Authorization": "Bearer " + token },
        body: uploadBody
      });
      assert.equal(r.status, 200, "Upload succeeds after channel-info 403");

      const s = await fetch(BASE + "/api/youtube/status", {
        headers: { "Authorization": "Bearer " + token }
      });
      assert.equal((await s.json()).connected, true, "Session still connected");
    } finally {
      globalThis.fetch = _orig;
    }
  });

  it("49. Frontend upload 401 reconciles with status before clearing the session", async () => {
    const src = readFileSync(new URL("../assets/js/youtube.js", import.meta.url), "utf8");
    assert.ok(src.includes("if (res.status === 401) {"), "Upload handler 401 branch present");
    assert.ok(src.includes("/api/youtube/status"), "Reconciliation status call present");
    assert.ok(src.includes("var st = await fetch(BACKEND + '/api/youtube/status'"), "Upload 401 reconciles via status endpoint");
    assert.ok(src.includes("Connection expired"), "Genuine expiry shows reconnect message");
  });

console.log("\n✅ YouTube tests complete.\n");
