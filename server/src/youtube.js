/**
 * Modern Living Hub — YouTube Content Posting Backend
 * Node.js + Express — isolated YouTube OAuth 2.0 and video upload integration.
 *
 * Environment variables (never hard-coded):
 *   YOUTUBE_CLIENT_ID      — Google API client ID
 *   YOUTUBE_CLIENT_SECRET  — Google API client secret (server-side only)
 *   YOUTUBE_REDIRECT_URI   — Exact callback URL registered in Google Cloud Console
 *   SESSION_SECRET         — Shared with the main server (for cookie encryption)
 *   FRONTEND_URL           — Full deployed frontend base URL
 */

import crypto from "node:crypto";
import multer from "multer";

// Google OAuth endpoints
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

// YouTube Data API v3 base
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";

// YouTube upload scope
const YT_SCOPES = ["https://www.googleapis.com/auth/youtube.upload"];

export function registerYouTubeRoutes(app, opts) {
  const { SESSION_SECRET, FRONTEND_URL, isProduction } = opts;

  const YT_CLIENT_ID = (process.env.YOUTUBE_CLIENT_ID || "").trim() || null;
  const YT_CLIENT_SECRET = (process.env.YOUTUBE_CLIENT_SECRET || "").trim() || null;
  const YT_REDIRECT_URI = (process.env.YOUTUBE_REDIRECT_URI || "").trim() || null;

  const ytConfigured = Boolean(YT_CLIENT_ID && YT_CLIENT_SECRET && YT_REDIRECT_URI);

  function ytGuard(req, res, next) {
    if (!ytConfigured) {
      return res.status(503).json({ error: "YouTube integration is not configured." });
    }
    next();
  }

  // ─── Encryption helpers (AES-256-GCM) ───
  const ENCRYPT_ALGO = "aes-256-gcm";

  function deriveKey(secret) {
    return crypto.createHash("sha256").update(secret).digest();
  }

  function encryptYT(data) {
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

  function decryptYT(str) {
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

  function persistYTToken(res, data) {
    const enc = encryptYT(data);
    if (!enc) return;
    res.cookie("mlh.ytoken", enc, {
      httpOnly: true, secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      maxAge: 1000 * 60 * 60 * 24 * 30,
      path: "/"
    });
  }

  function readYTToken(req) {
    const enc = req.cookies["mlh.ytoken"] || req.signedCookies["mlh.ytoken"] || null;
    return decryptYT(enc);
  }

  function clearYTToken(res) {
    res.clearCookie("mlh.ytoken", { path: "/" });
  }

  // ─── In-memory stores ───
  const ytTokenStore = new Map();        // sessionId → { youtube, expires }
  const ytHandoffStore = new Map();      // code → { sessionId, expires }
  const ytSessionTokenStore = new Map(); // bearer token → { sessionId, expires }

  const YT_TOKEN_TTL = 1000 * 60 * 60 * 24 * 30;   // 30 days
  const YT_HANDOFF_TTL = 5 * 60 * 1000;              // 5 minutes
  const YT_BEARER_TTL = 1000 * 60 * 60 * 24;         // 24 hours

  function storeYTTokens(sessionId, data) {
    ytTokenStore.set(sessionId, { youtube: data, expires: Date.now() + YT_TOKEN_TTL });
  }
  function getYTTokens(sessionId) {
    const e = ytTokenStore.get(sessionId);
    if (!e) return null;
    if (Date.now() > e.expires) { ytTokenStore.delete(sessionId); return null; }
    return e.youtube;
  }
  function deleteYTTokens(sessionId) { ytTokenStore.delete(sessionId); }

  function createYTHandoff(sessionId) {
    const code = crypto.randomBytes(32).toString("hex");
    ytHandoffStore.set(code, { sessionId, expires: Date.now() + YT_HANDOFF_TTL });
    return code;
  }
  function consumeYTHandoff(code) {
    const e = ytHandoffStore.get(code);
    if (!e) return null;
    if (Date.now() > e.expires) { ytHandoffStore.delete(code); return null; }
    ytHandoffStore.delete(code);
    return e;
  }

  function createYTSessionToken(sessionId) {
    const t = crypto.randomBytes(32).toString("hex");
    ytSessionTokenStore.set(t, { sessionId, expires: Date.now() + YT_BEARER_TTL });
    return t;
  }
  function resolveYTSessionToken(t) {
    const e = ytSessionTokenStore.get(t);
    if (!e) return null;
    if (Date.now() > e.expires) { ytSessionTokenStore.delete(t); return null; }
    return e.sessionId;
  }

  // ─── Token resolution ───
  function getYTUserToken(req) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith("Bearer ")) {
      const sid = resolveYTSessionToken(auth.slice(7));
      if (sid) {
        const yt = getYTTokens(sid);
        if (yt && yt.access_token) return { access_token: yt.access_token, sessionId: sid };
      }
    }
    return null;
  }

  function getYTSessionId(req) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith("Bearer ")) {
      const sid = resolveYTSessionToken(auth.slice(7));
      if (sid) return sid;
    }
    return null;
  }

  function getYTFullTokens(req) {
    const sid = getYTSessionId(req);
    const fromMemory = sid ? getYTTokens(sid) : null;
    return fromMemory || readYTToken(req);
  }

  // ─── Token refresh ───
  async function refreshAccessToken(sessionId, refreshToken) {
    try {
      const body = new URLSearchParams({
        client_id: YT_CLIENT_ID,
        client_secret: YT_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token"
      }).toString();

      const r = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });

      const raw = await r.json().catch(() => ({}));
      if (raw.error) {
        console.error("YouTube token refresh failed:", raw.error);
        return null;
      }

      const tokens = getYTTokens(sessionId) || {};
      const newTokens = {
        ...tokens,
        access_token: raw.access_token,
        expires_at: Date.now() + (raw.expires_in || 3600) * 1000,
        token_type: raw.token_type || "Bearer"
      };
      storeYTTokens(sessionId, newTokens);
      return newTokens.access_token;
    } catch (err) {
      console.error("YouTube token refresh error:", err.message);
      return null;
    }
  }

  // ─── Authenticated fetch with auto-refresh ───
  async function ytFetch(url, opts, sessionId) {
    const tokenData = sessionId ? getYTTokens(sessionId) : null;
    if (!tokenData || !tokenData.access_token) {
      return { ok: false, status: 401, json: () => ({ error: { code: 401, message: "Not authenticated" } }) };
    }

    // Check expiry — refresh proactively if within 5 minutes
    if (tokenData.expires_at && Date.now() > tokenData.expires_at - 5 * 60 * 1000) {
      if (tokenData.refresh_token) {
        const newToken = await refreshAccessToken(sessionId, tokenData.refresh_token);
        if (newToken) {
          opts.headers = { ...opts.headers, Authorization: "Bearer " + newToken };
          const r = await fetch(url, opts);
          if (r.status === 401 && tokenData.refresh_token) {
            // Retry with refreshed token
            const rt = await refreshAccessToken(sessionId, tokenData.refresh_token);
            if (rt) {
              opts.headers = { ...opts.headers, Authorization: "Bearer " + rt };
              return fetch(url, opts);
            }
          }
          return r;
        }
        return { ok: false, status: 401, json: () => ({ error: { code: 401, message: "Token refresh failed" } }) };
      }
    }

    const r = await fetch(url, opts);
    if (r.status === 401 && tokenData.refresh_token) {
      const newToken = await refreshAccessToken(sessionId, tokenData.refresh_token);
      if (newToken) {
        opts.headers = { ...opts.headers, Authorization: "Bearer " + newToken };
        return fetch(url, opts);
      }
    }
    return r;
  }

  // ─── YouTube category ID lookup ───
  const YT_CATEGORIES = {
    "Film & Animation": "1",
    "Autos & Vehicles": "2",
    "Music": "10",
    "Pets & Animals": "15",
    "Sports": "17",
    "Short Movies": "18",
    "Travel & Events": "19",
    "Gaming": "20",
    "Videoblogging": "21",
    "People & Blogs": "22",
    "Comedy": "23",
    "Entertainment": "24",
    "News & Politics": "25",
    "Howto & Style": "26",
    "Education": "27",
    "Science & Technology": "28",
    "Nonprofits & Activism": "29"
  };

  // ─── Multer for video uploads (in-memory, streaming) ───
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 128 * 1024 * 1024 } // 128 MB max
  });

  // ─── Health ───
  app.get("/api/youtube/health", (req, res) => {
    res.json({
      status: "ok",
      service: "modern-living-hub-youtube",
      youtube_configured: ytConfigured,
      scopes: YT_SCOPES,
      privacy_note: "Unverified API projects are restricted to private uploads until Google audit is passed."
    });
  });

  // ─── OAuth start ───
  app.get("/youtube/auth", ytGuard, (req, res) => {
    const state = crypto.randomBytes(32).toString("hex");
    if (!req.session.sessionId) req.session.sessionId = crypto.randomUUID();
    req.session.yt_oauth_state = state;

    res.cookie("mlh.yt.oauth_state", state, {
      httpOnly: true, secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      maxAge: 10 * 60 * 1000, signed: true,
      path: "/"
    });

    const params = new URLSearchParams({
      client_id: YT_CLIENT_ID,
      response_type: "code",
      redirect_uri: YT_REDIRECT_URI,
      scope: YT_SCOPES.join(" "),
      state,
      access_type: "offline",
      prompt: "consent"
    });

    console.log("YouTube OAuth client: " + (YT_CLIENT_ID.substring(0, 8) + "..." + YT_CLIENT_ID.substring(YT_CLIENT_ID.length - 6)));
    console.log("YouTube OAuth redirect URI: " + YT_REDIRECT_URI);
    console.log("YouTube OAuth endpoint: " + GOOGLE_AUTH_URL);
    console.log("YouTube OAuth scope: " + YT_SCOPES.join(" "));
    console.log("YouTube OAuth start: state generated (length=" + state.length + ")");
    res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
  });

  // ─── OAuth callback ───
  app.get("/youtube/auth/callback", ytGuard, async (req, res) => {
    const { code, state, error } = req.query;
    const cookieState = req.signedCookies["mlh.yt.oauth_state"] || null;

    if (error) {
      console.error("YouTube OAuth callback error:", error);
      res.clearCookie("mlh.yt.oauth_state", { path: "/" });
      return res.redirect(`${FRONTEND_URL}/youtube.html?yt_error=${encodeURIComponent(error)}`);
    }

    // Validate state
    if (!state || state !== cookieState) {
      console.error("YouTube OAuth state mismatch");
      res.clearCookie("mlh.yt.oauth_state", { path: "/" });
      return res.redirect(`${FRONTEND_URL}/youtube.html?yt_error=invalid_state`);
    }

    if (!code) {
      return res.redirect(`${FRONTEND_URL}/youtube.html?yt_error=no_code`);
    }

    try {
      // Exchange authorization code for tokens
      const body = new URLSearchParams({
        code,
        client_id: YT_CLIENT_ID,
        client_secret: YT_CLIENT_SECRET,
        redirect_uri: YT_REDIRECT_URI,
        grant_type: "authorization_code"
      }).toString();

      const r = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });

      const raw = await r.json().catch(() => ({}));

      if (raw.error) {
        console.error("YouTube token exchange error:", raw.error);
        return res.redirect(`${FRONTEND_URL}/youtube.html?yt_error=token_exchange_failed`);
      }

      const accessToken = raw.access_token;
      const refreshToken = raw.refresh_token || null;
      const expiresIn = raw.expires_in || 3600;
      const tokenType = raw.token_type || "Bearer";
      const scope = raw.scope || YT_SCOPES.join(" ");

      if (!accessToken) {
        return res.redirect(`${FRONTEND_URL}/youtube.html?yt_error=no_access_token`);
      }

      // Retrieve channel info
      let channelInfo = null;
      try {
        const cr = await fetch(
          `${YOUTUBE_API_BASE}/channels?part=snippet,contentDetails&mine=true`,
          { headers: { Authorization: "Bearer " + accessToken } }
        );
        const cdata = await cr.json().catch(() => ({}));
        if (cdata.items && cdata.items.length > 0) {
          const ch = cdata.items[0];
          channelInfo = {
            id: ch.id,
            title: ch.snippet?.title || "Unknown",
            description: ch.snippet?.description || "",
            thumbnail: ch.snippet?.thumbnails?.default?.url || "",
            uploads_playlist_id: ch.contentDetails?.relatedPlaylists?.uploads || ""
          };
        }
      } catch (err) {
        console.error("YouTube channel fetch error:", err.message);
      }

      // Store tokens server-side
      const sessionId = req.session.sessionId;
      const tokenData = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: Date.now() + expiresIn * 1000,
        token_type: tokenType,
        scope,
        channel: channelInfo,
        connected_at: Date.now()
      };
      storeYTTokens(sessionId, tokenData);
      persistYTToken(res, tokenData);

      // Clear the OAuth state cookie after successful validation (consumed)
      res.clearCookie("mlh.yt.oauth_state", { path: "/" });

      // Create one-time handoff code
      const handoffCode = createYTHandoff(sessionId);

      console.log("YouTube OAuth success: channel=" + (channelInfo?.title || "unknown"));

      // Redirect to frontend with handoff
      res.redirect(`${FRONTEND_URL}/youtube.html?youtube_connected=1&yt_handoff=${handoffCode}`);

    } catch (err) {
      console.error("YouTube OAuth callback error:", err.message);
      return res.redirect(`${FRONTEND_URL}/youtube.html?yt_error=callback_error`);
    }
  });

  // ─── Complete handoff (one-time code → bearer session token) ───
  app.post("/api/youtube/complete", (req, res) => {
    const { handoff } = req.body || {};
    if (!handoff) {
      return res.status(400).json({ error: "Missing handoff code." });
    }

    const entry = consumeYTHandoff(handoff);
    if (!entry) {
      return res.status(400).json({ error: "Invalid or expired handoff code." });
    }

    const { sessionId } = entry;
    const tokens = getYTTokens(sessionId);
    if (!tokens || !tokens.access_token) {
      return res.status(400).json({ error: "YouTube tokens not found. Please reconnect." });
    }

    const sessionToken = createYTSessionToken(sessionId);
    res.json({ connected: true, session_token: sessionToken });
  });

  // ─── Status ───
  app.get("/api/youtube/status", (req, res) => {
    const sid = getYTSessionId(req);
    const yt = (sid ? getYTTokens(sid) : null) || readYTToken(req);
    const connected = Boolean(yt && yt.access_token);
    if (!connected) return res.json({ connected: false });
    res.json({
      connected: true,
      channel: yt.channel || null,
      connected_at: yt.connected_at || null
    });
  });

  // ─── Channel ───
  app.get("/api/youtube/channel", async (req, res) => {
    const tokenData = getYTUserToken(req);
    if (!tokenData) return res.status(401).json({ error: "Not connected to YouTube." });

    const r = await ytFetch(
      `${YOUTUBE_API_BASE}/channels?part=snippet,contentDetails&mine=true`,
      {
        headers: { Authorization: "Bearer " + tokenData.access_token }
      },
      tokenData.sessionId
    );

    const raw = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ error: raw?.error?.message || "Failed to fetch channel." });
    }

    const ch = raw.items?.[0];
    if (!ch) {
      return res.status(404).json({ error: "No YouTube channel found." });
    }

    res.json({
      channel: {
        id: ch.id,
        title: ch.snippet?.title || "Unknown",
        description: ch.snippet?.description || "",
        thumbnail: ch.snippet?.thumbnails?.default?.url || "",
        uploads_playlist_id: ch.contentDetails?.relatedPlaylists?.uploads || ""
      }
    });
  });

  // ─── Upload ───
  app.post("/api/youtube/upload", upload.single("video"), async (req, res) => {
    const tokenData = getYTUserToken(req);
    if (!tokenData) return res.status(401).json({ error: "Not connected to YouTube." });

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "No video file provided." });
    }

    const title = (req.body.title || "").trim();
    const description = (req.body.description || "").trim();
    const tags = (req.body.tags || "").split(",").map(t => t.trim()).filter(Boolean);
    const categoryId = YT_CATEGORIES[req.body.category] || req.body.category || "22";
    const privacyStatus = req.body.privacyStatus || "private";
    const madeForKids = req.body.madeForKids === "true" || req.body.madeForKids === true;

    if (!title) {
      return res.status(400).json({ error: "Title is required." });
    }

    const validPrivacy = ["private", "unlisted", "public"];
    if (!validPrivacy.includes(privacyStatus)) {
      return res.status(400).json({ error: "Invalid privacyStatus. Must be: private, unlisted, or public." });
    }

    if (privacyStatus === "public") {
      console.log("YouTube upload: public privacy requested — may be restricted for unverified projects");
    }

    try {
      // Build multipart form data for YouTube upload
      const metadata = {
        snippet: { title, description, tags, categoryId },
        status: { privacyStatus, selfDeclaredMadeForKids: madeForKids }
      };

      const boundary = "ModernLivingHub" + crypto.randomBytes(16).toString("hex");
      const parts = [];

      // Metadata part
      parts.push(
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify(metadata) + "\r\n"
      );

      // Video file part
      const fileContentType = file.mimetype || "video/mp4";
      parts.push(
        `--${boundary}\r\n` +
        `Content-Type: ${fileContentType}\r\n` +
        `Content-Transfer-Encoding: binary\r\n\r\n`
      );

      const metadataPart = Buffer.from(parts[0], "utf8");
      const preFilePart = Buffer.from(parts[1], "utf8");
      const endBoundary = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

      const body = Buffer.concat([metadataPart, preFilePart, file.buffer, endBoundary]);

      const r = await ytFetch(
        `${YOUTUBE_UPLOAD_URL}?part=snippet,status&uploadType=multipart`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + tokenData.access_token,
            "Content-Type": `multipart/related; boundary=${boundary}`,
            "Content-Length": String(body.length)
          },
          body
        },
        tokenData.sessionId
      );

      const raw = await r.json().catch(() => ({}));

      if (!r.ok) {
        const errMsg = raw?.error?.message || `YouTube upload failed (HTTP ${r.status})`;
        console.error("YouTube upload error:", r.status, errMsg);
        return res.status(r.status).json({ error: errMsg });
      }

      const videoId = raw.id;
      console.log("YouTube upload success: videoId=" + videoId);

      res.json({
        success: true,
        video_id: videoId,
        video_url: `https://www.youtube.com/watch?v=${videoId}`,
        title,
        privacy_status: privacyStatus
      });

    } catch (err) {
      console.error("YouTube upload error:", err.message);
      res.status(502).json({ error: "Could not complete YouTube upload: " + err.message });
    }
  });

  // ─── Video status ───
  app.get("/api/youtube/video-status/:videoId", async (req, res) => {
    const tokenData = getYTUserToken(req);
    if (!tokenData) return res.status(401).json({ error: "Not connected to YouTube." });

    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ error: "videoId is required." });

    const r = await ytFetch(
      `${YOUTUBE_API_BASE}/videos?part=processingDetails,status&id=${encodeURIComponent(videoId)}`,
      {
        headers: { Authorization: "Bearer " + tokenData.access_token }
      },
      tokenData.sessionId
    );

    const raw = await r.json().catch(() => ({}));

    if (!r.ok) {
      return res.status(r.status).json({ error: raw?.error?.message || "Failed to fetch video status." });
    }

    const video = raw.items?.[0];
    if (!video) {
      return res.status(404).json({ error: "Video not found." });
    }

    res.json({
      video_id: video.id,
      title: video.snippet?.title || "",
      processing_status: video.processingDetails?.processingStatus || "unknown",
      upload_status: video.status?.uploadStatus || "unknown",
      privacy_status: video.status?.privacyStatus || "unknown",
      failure_reason: video.processingDetails?.failureReason || null,
      rejection_reason: video.processingDetails?.rejectionReason || null
    });
  });

  // ─── Disconnect ───
  app.post("/api/youtube/disconnect", (req, res) => {
    const sid = getYTSessionId(req);
    if (sid) deleteYTTokens(sid);
    delete req.session?.yt_oauth_state;
    clearYTToken(res);
    for (const [t, e] of ytSessionTokenStore.entries()) {
      if (e.sessionId === sid) ytSessionTokenStore.delete(t);
    }
    console.log("YouTube disconnected");
    res.json({ disconnected: true });
  });
}
