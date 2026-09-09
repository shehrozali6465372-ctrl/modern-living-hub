/**
 * Modern Living Hub — TikTok Content Posting API Backend
 * Node.js + Express — isolated TikTok OAuth 2.0 and Direct Post integration.
 *
 * Environment variables (never hard-coded):
 *   TIKTOK_CLIENT_KEY     — TikTok app client key
 *   TIKTOK_CLIENT_SECRET  — TikTok app client secret (server-side only)
 *   TIKTOK_REDIRECT_URI   — Exact callback URL registered in TikTok Developer Portal
 *   SESSION_SECRET        — Shared with the main server (for cookie encryption)
 *   FRONTEND_URL          — Full deployed frontend base URL
 */

import crypto from "node:crypto";

// TikTok API endpoints
const TIKTOK_AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const TIKTOK_API_BASE = "https://open.tiktokapis.com/v2";
const TIKTOK_SCOPES = ["video.publish"];

export function registerTikTokRoutes(app, opts) {
  // opts: { SESSION_SECRET, FRONTEND_URL, isProduction }
  const { SESSION_SECRET, FRONTEND_URL, isProduction } = opts;

  const TT_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || null;
  const TT_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || null;
  const TT_REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI || null;

  const ttConfigured = Boolean(TT_CLIENT_KEY && TT_CLIENT_SECRET && TT_REDIRECT_URI);

  function ttGuard(req, res, next) {
    if (!ttConfigured) {
      return res.status(503).json({ error: "TikTok integration is not configured. Set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, and TIKTOK_REDIRECT_URI." });
    }
    next();
  }

  // ─── Encrypted token persistence (mirrors Pinterest pattern) ───
  const ENCRYPT_ALGO = "aes-256-gcm";

  function deriveKey(secret) {
    return crypto.createHash("sha256").update(secret).digest();
  }

  function encryptTT(data) {
    try {
      const key = deriveKey(SESSION_SECRET);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(ENCRYPT_ALGO, key, iv);
      const json = JSON.stringify(data);
      const encrypted = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return iv.toString("base64") + "." + encrypted.toString("base64") + "." + tag.toString("base64");
    } catch { return null; }
  }

  function decryptTT(str) {
    try {
      if (!str) return null;
      const [ivB64, encB64, tagB64] = str.split(".");
      if (!ivB64 || !encB64 || !tagB64) return null;
      const key = deriveKey(SESSION_SECRET);
      const iv = Buffer.from(ivB64, "base64");
      const enc = Buffer.from(encB64, "base64");
      const tag = Buffer.from(tagB64, "base64");
      const d = crypto.createDecipheriv(ENCRYPT_ALGO, key, iv);
      d.setAuthTag(tag);
      const dec = Buffer.concat([d.update(enc), d.final()]);
      return JSON.parse(dec.toString("utf8"));
    } catch { return null; }
  }

  function persistTTToken(res, data) {
    const enc = encryptTT(data);
    if (!enc) return;
    res.cookie("mlh.tt.token", enc, {
      httpOnly: true, secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      maxAge: 1000 * 60 * 60 * 24 * 30
    });
  }

  function readTTToken(req) {
    const enc = req.cookies["mlh.tt.token"] || req.signedCookies["mlh.tt.token"] || null;
    return decryptTT(enc);
  }

  function clearTTToken(res) {
    res.clearCookie("mlh.tt.token");
  }

  // ─── In-memory stores (ephemeral — lost on hibernation, cookie fallback) ───
  const ttTokenStore = new Map();   // sessionId → { tiktok, expires }
  const ttHandoffStore = new Map(); // code → { sessionId, expires }
  const ttSessionTokenStore = new Map(); // bearer token → { sessionId, expires }

  const TT_TOKEN_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days
  const TT_HANDOFF_TTL = 5 * 60 * 1000;           // 5 minutes
  const TT_BEARER_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days

  function storeTTTokens(sessionId, data) {
    ttTokenStore.set(sessionId, { tiktok: data, expires: Date.now() + TT_TOKEN_TTL });
  }
  function getTTTokens(sessionId) {
    const e = ttTokenStore.get(sessionId);
    if (!e) return null;
    if (Date.now() > e.expires) { ttTokenStore.delete(sessionId); return null; }
    return e.tiktok;
  }
  function deleteTTTokens(sessionId) { ttTokenStore.delete(sessionId); }

  function createTTHandoff(sessionId) {
    const code = crypto.randomBytes(32).toString("hex");
    ttHandoffStore.set(code, { sessionId, expires: Date.now() + TT_HANDOFF_TTL });
    return code;
  }
  function consumeTTHandoff(code) {
    const e = ttHandoffStore.get(code);
    if (!e) return null;
    if (Date.now() > e.expires) { ttHandoffStore.delete(code); return null; }
    ttHandoffStore.delete(code);
    return e;
  }

  function createTTSessionToken(sessionId) {
    const t = crypto.randomBytes(32).toString("hex");
    ttSessionTokenStore.set(t, { sessionId, expires: Date.now() + TT_BEARER_TTL });
    return t;
  }
  function resolveTTSessionToken(t) {
    const e = ttSessionTokenStore.get(t);
    if (!e) return null;
    if (Date.now() > e.expires) { ttSessionTokenStore.delete(t); return null; }
    return e.sessionId;
  }

  // ─── Token resolution ───
  function getTTUserToken(req) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith("Bearer ")) {
      const sid = resolveTTSessionToken(auth.slice(7));
      if (sid) {
        const tt = getTTTokens(sid);
        if (tt && tt.access_token) return tt.access_token;
        const cookie = readTTToken(req);
        if (cookie && cookie.access_token) {
          storeTTTokens(sid, cookie);
          return cookie.access_token;
        }
      }
    }
    return null;
  }

  function getTTSessionId(req) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith("Bearer ")) {
      const sid = resolveTTSessionToken(auth.slice(7));
      if (sid) return sid;
    }
    return null;
  }

  function getTTFullTokens(req) {
    const sid = getTTSessionId(req);
    const fromMemory = sid ? getTTTokens(sid) : null;
    return fromMemory || readTTToken(req);
  }

  // ─── Health ───
  app.get("/api/tiktok/health", (req, res) => {
    res.json({
      status: "ok",
      service: "modern-living-hub-tiktok",
      tiktok_configured: ttConfigured,
      scopes: TIKTOK_SCOPES
    });
  });

  // ─── OAuth start ───
  app.get("/tiktok/auth", ttGuard, (req, res) => {
    const state = crypto.randomBytes(32).toString("hex");
    if (!req.session.sessionId) req.session.sessionId = crypto.randomUUID();
    req.session.tt_oauth_state = state;

    res.cookie("mlh.tt.oauth_state", state, {
      httpOnly: true, secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      maxAge: 10 * 60 * 1000, signed: true
    });

    const params = new URLSearchParams({
      client_key: TT_CLIENT_KEY,
      response_type: "code",
      redirect_uri: TT_REDIRECT_URI,
      scope: TIKTOK_SCOPES.join(","),
      state
    });

    console.log("TikTok OAuth start: state generated (length=" + state.length + ")");

    // --- Safe diagnostic (fires on every OAuth start request) ---
    const _k = process.env.TIKTOK_CLIENT_KEY || null;
    const _r = process.env.TIKTOK_REDIRECT_URI || null;
    function _fp(s) { return s ? crypto.createHash("sha256").update(s).digest("hex") : "NOT SET"; }
    console.log("[tiktok-diag] TIKTOK_CLIENT_KEY length=" + (_k ? _k.length : 0) + " sha256=" + _fp(_k));
    console.log("[tiktok-diag] TIKTOK_REDIRECT_URI value=" + (_r || "NOT SET") + " sha256=" + _fp(_r));
    const _builtUrl = `${TIKTOK_AUTH_URL}?${params.toString()}`;
    const _urlKey = new URL(_builtUrl).searchParams.get("client_key");
    console.log("[tiktok-diag] OAuth URL client_key sha256=" + _fp(_urlKey) + " match_env=" + (_fp(_urlKey) === _fp(_k)));
    console.log("[tiktok-diag] OAuth redirect_uri=" + params.get("redirect_uri"));
    res.redirect(`${TIKTOK_AUTH_URL}?${params.toString()}`);
  });

  // ─── OAuth callback ───
  app.get("/tiktok/auth/callback", ttGuard, async (req, res) => {
    const { code, state, error, error_description } = req.query;
    const cookieState = req.signedCookies["mlh.tt.oauth_state"] || null;

    console.log("TikTok callback: session=" + Boolean(req.session) + ", session_state=" + Boolean(req.session.tt_oauth_state) + ", cookie_state=" + Boolean(cookieState) + ", callback_state=" + Boolean(state));

    if (error) {
      const msg = error_description || "TikTok authorization failed.";
      res.clearCookie("mlh.tt.oauth_state");
      return res.redirect(`${FRONTEND_URL}/tiktok.html?tiktok_error=${encodeURIComponent(msg)}`);
    }
    if (!code || !state) {
      res.clearCookie("mlh.tt.oauth_state");
      return res.redirect(`${FRONTEND_URL}/tiktok.html?tiktok_error=Missing authorization code or state.`);
    }

    const sessionState = req.session.tt_oauth_state || null;
    const stateValid = (sessionState && state === sessionState) || (cookieState && state === cookieState);
    if (!stateValid) {
      console.log("TikTok state validation FAILED");
      res.clearCookie("mlh.tt.oauth_state");
      return res.redirect(`${FRONTEND_URL}/tiktok.html?tiktok_error=Invalid OAuth state. Please try again.`);
    }
    console.log("TikTok state validation PASSED");
    delete req.session.tt_oauth_state;
    res.clearCookie("mlh.tt.oauth_state");

    try {
      const body = new URLSearchParams({
        client_key: TT_CLIENT_KEY,
        client_secret: TT_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: TT_REDIRECT_URI
      });

      console.log("TikTok token exchange: sending request to", TIKTOK_TOKEN_URL);
      console.log("TikTok token exchange: grant_type=authorization_code, code_length=" + (code ? code.length : 0) + ", redirect_uri=" + TT_REDIRECT_URI);

      const tokenRes = await fetch(TIKTOK_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      });

      const responseContentType = tokenRes.headers.get("content-type") || "unknown";
      const responseText = await tokenRes.text().catch(() => "");
      console.log("[tiktok-token] HTTP " + tokenRes.status + " content-type=" + responseContentType + " body_length=" + responseText.length);
      // Strip secrets from body preview before logging
      const _safePreview = responseText.slice(0, 500).replace(/"access_token"\s*:\s*"[^"]*"/g, '"access_token":"[REDACTED]"').replace(/"refresh_token"\s*:\s*"[^"]*"/g, '"refresh_token":"[REDACTED]"');
      console.log("[tiktok-token] body_preview=" + _safePreview);

      let rawData = {};
      try { rawData = JSON.parse(responseText); } catch (e) {
        console.error("[tiktok-token] JSON parse failed:", e.message);
      }

      // TikTok wraps data/error in a top-level { data: {...}, error: {...} } envelope
      const tkError = rawData.error || null;
      const tkData = rawData.data || null;

      if (tkError && tkError.code !== "ok") {
        const errMsg = tkError.message || "Token exchange failed";
        console.error("[tiktok-token] TikTok error:", JSON.stringify({
          code: tkError.code, message: tkError.message, log_id: tkError.log_id || null,
          error: tkError.error || null, error_description: tkError.error_description || null
        }));
        return res.redirect(`${FRONTEND_URL}/tiktok.html?tiktok_error=${encodeURIComponent("Could not exchange code: " + errMsg)}`);
      }

      if (!tkData || !tkData.access_token) {
        console.error("[tiktok-token] No access_token in response. tkData=" + JSON.stringify(tkData) + " tkError=" + JSON.stringify(tkError));
        return res.redirect(`${FRONTEND_URL}/tiktok.html?tiktok_error=No access token returned by TikTok.`);
      }

      console.log("[tiktok-token] SUCCESS: token_received=true, refresh_token_received=" + Boolean(tkData.refresh_token) + ", scope=" + (tkData.scope || "none") + ", open_id=" + (tkData.open_id || "none"));

      const connectedAt = new Date().toISOString();
      const tiktokData = {
        access_token: tkData.access_token,
        refresh_token: tkData.refresh_token || null,
        open_id: tkData.open_id || null,
        scope: tkData.scope || TIKTOK_SCOPES.join(","),
        token_type: tkData.token_type || "bearer",
        expires_in: tkData.expires_in || null,
        connected_at: connectedAt
      };

      storeTTTokens(req.session.sessionId, tiktokData);
      persistTTToken(res, tiktokData);

      const handoffCode = createTTHandoff(req.session.sessionId);
      console.log("TikTok callback complete: tokens stored, handoff created");

      res.redirect(`${FRONTEND_URL}/tiktok.html?tiktok_connected=1&tt_handoff=${handoffCode}`);
    } catch (err) {
      console.error("TikTok callback error:", err.message);
      res.redirect(`${FRONTEND_URL}/tiktok.html?tiktok_error=${encodeURIComponent("Network error during TikTok authentication.")}`);
    }
  });

  // ─── Complete handoff → bearer session token ───
  app.post("/api/tiktok/complete", (req, res) => {
    const { handoff } = req.body;
    if (!handoff || typeof handoff !== "string") {
      return res.status(400).json({ error: "Missing handoff code." });
    }
    const entry = consumeTTHandoff(handoff);
    if (!entry) {
      return res.status(400).json({ error: "Invalid or expired handoff code." });
    }
    const tt = getTTTokens(entry.sessionId) || readTTToken(req);
    if (!tt || !tt.access_token) {
      return res.status(400).json({ error: "TikTok tokens not found. Please reconnect." });
    }
    if (!getTTTokens(entry.sessionId) && tt) storeTTTokens(entry.sessionId, tt);
    const bearerToken = createTTSessionToken(entry.sessionId);
    console.log("TikTok handoff complete: session token created");
    res.json({ connected: true, session_token: bearerToken });
  });

  // ─── Status ───
  app.get("/api/tiktok/status", (req, res) => {
    const sid = getTTSessionId(req);
    const tt = (sid ? getTTTokens(sid) : null) || readTTToken(req);
    const connected = Boolean(tt && tt.access_token);
    console.log("TikTok status:", JSON.stringify({ connected }));
    if (!connected) return res.json({ connected: false });
    res.json({
      connected: true,
      open_id: tt.open_id || null,
      connected_at: tt.connected_at || null,
      scope: tt.scope || null
    });
  });

  // ─── Disconnect ───
  app.post("/api/tiktok/disconnect", (req, res) => {
    const sid = getTTSessionId(req);
    if (sid) deleteTTTokens(sid);
    delete req.session?.tt_oauth_state;
    clearTTToken(res);
    for (const [t, e] of ttSessionTokenStore.entries()) {
      if (e.sessionId === sid) ttSessionTokenStore.delete(t);
    }
    console.log("TikTok disconnected");
    res.json({ disconnected: true });
  });

  // ─── Creator info ───
  app.get("/api/tiktok/creator", async (req, res) => {
    const token = getTTUserToken(req);
    if (!token) return res.status(401).json({ error: "Not connected to TikTok." });

    try {
      // Query creator info for Direct Post
      const r = await fetch(`${TIKTOK_API_BASE}/post/publish/creator_info/query/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: "{}"
      });
      const raw = await r.json().catch(() => ({}));
      if (raw.error && raw.error.code !== "ok") {
        console.error("TikTok creator info error:", JSON.stringify(raw.error));
        return res.status(400).json({ error: "Could not retrieve TikTok creator info: " + (raw.error.message || "Unknown error") });
      }
      const d = raw.data || {};
      res.json({
        open_id: d.open_id || null,
        creator_username: d.creator_username || null,
        creator_nickname: d.creator_nickname || null,
        privacy_level_options: d.privacy_level_options || [],
        max_video_post_duration_sec: d.max_video_post_duration_sec || null,
        max_video_size: d.max_video_size || null,
        can_post: Boolean(d.can_post !== false),
        status: d.status || null
      });
    } catch (err) {
      console.error("TikTok creator fetch error:", err.message);
      res.status(502).json({ error: "Could not reach TikTok API." });
    }
  });

  // ─── Initialize Direct Post ───
  app.post("/api/tiktok/post/init", async (req, res) => {
    const token = getTTUserToken(req);
    if (!token) return res.status(401).json({ error: "Not connected to TikTok." });

    const { title, privacy_level, disable_duet, disable_comment, disable_stitch, video_cover_timestamp_ms, source } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Caption/title is required." });
    }

    const postInfo = {
      title: title.trim(),
      privacy_level: privacy_level || "PUBLIC_TO_EVERYONE",
      disable_duet: Boolean(disable_duet),
      disable_comment: Boolean(disable_comment),
      disable_stitch: Boolean(disable_stitch),
      video_cover_timestamp_ms: video_cover_timestamp_ms || 0,
      source_info: { source: source || "FILE_UPLOAD" },
      post_mode: "DIRECT_POST"
    };

    try {
      const r = await fetch(`${TIKTOK_API_BASE}/post/publish/video/init/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ post_info: postInfo })
      });
      const raw = await r.json().catch(() => ({}));

      if (raw.error && raw.error.code !== "ok") {
        console.error("TikTok post init error:", JSON.stringify({ status: r.status, code: raw.error.code, message: raw.error.message, log_id: raw.error.log_id }));
        return res.status(400).json({
          error: "TikTok rejected the post initialization: " + (raw.error.message || "Unknown error"),
          tiktok_error_code: raw.error.code,
          log_id: raw.error.log_id
        });
      }

      const d = raw.data || {};
      res.json({
        success: true,
        publish_id: d.publish_id || null,
        upload_url: d.upload_url || null
      });
    } catch (err) {
      console.error("TikTok post init error:", err.message);
      res.status(502).json({ error: "Could not reach TikTok API." });
    }
  });

  // ─── Upload video to TikTok ───
  app.post("/api/tiktok/post/upload", async (req, res) => {
    const token = getTTUserToken(req);
    if (!token) return res.status(401).json({ error: "Not connected to TikTok." });

    const { upload_url, video_data } = req.body;
    if (!upload_url || !video_data) {
      return res.status(400).json({ error: "upload_url and video_data (base64) are required." });
    }

    try {
      const videoBuffer = Buffer.from(video_data, "base64");
      const r = await fetch(upload_url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "video/mp4"
        },
        body: videoBuffer
      });

      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        console.error("TikTok upload failed:", r.status, errText.slice(0, 200));
        return res.status(400).json({ error: "TikTok upload failed (HTTP " + r.status + ")." });
      }

      console.log("TikTok upload successful");
      res.json({ success: true });
    } catch (err) {
      console.error("TikTok upload error:", err.message);
      res.status(502).json({ error: "Could not upload video to TikTok." });
    }
  });

  // ─── Check post processing status ───
  app.post("/api/tiktok/post/status", async (req, res) => {
    const token = getTTUserToken(req);
    if (!token) return res.status(401).json({ error: "Not connected to TikTok." });

    const { publish_id } = req.body;
    if (!publish_id) return res.status(400).json({ error: "publish_id is required." });

    try {
      const r = await fetch(`${TIKTOK_API_BASE}/post/publish/status/fetch/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ publish_id })
      });
      const raw = await r.json().catch(() => ({}));

      if (raw.error && raw.error.code !== "ok") {
        console.error("TikTok status error:", JSON.stringify(raw.error));
        return res.status(400).json({ error: "Could not check status: " + (raw.error.message || "Unknown error") });
      }

      const d = raw.data || {};
      res.json({
        status: d.status || "UNKNOWN",
        post_url: d.post_url || null,
        error_code: d.error_code || null,
        error_msg: d.error_msg || null,
        publish_id: d.publish_id || publish_id
      });
    } catch (err) {
      console.error("TikTok status check error:", err.message);
      res.status(502).json({ error: "Could not reach TikTok API." });
    }
  });

  // ─── Expose ttConfigured for health ───
  app.get("/api/tiktok/config-status", (req, res) => {
    res.json({
      tiktok_configured: ttConfigured,
      client_key_configured: Boolean(TT_CLIENT_KEY),
      redirect_uri_configured: Boolean(TT_REDIRECT_URI)
    });
  });

  console.log("TikTok routes registered", ttConfigured ? "(configured)" : "(not configured — set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REDIRECT_URI)");

}
