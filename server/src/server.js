/**
 * Modern Living Hub — Pinterest OAuth Backend
 * Node.js + Express backend for real Pinterest OAuth 2.0 and API v5 integration.
 *
 * Environment variables (never hard-coded):
 *   PINTEREST_CLIENT_ID     — Pinterest app client ID
 *   PINTEREST_CLIENT_SECRET — Pinterest app client secret (server-side only)
 *   PINTEREST_REDIRECT_URI  — Exact callback URL registered with Pinterest
 *   SESSION_SECRET          — Secret for express-session
 *   FRONTEND_URL            — Full deployed frontend base URL including project path (e.g. https://shehrozali6465372-ctrl.github.io/modern-living-hub)
 */

import express from "express";
import session from "express-session";
import crypto from "node:crypto";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Required environment variables ───
const CLIENT_ID = process.env.PINTEREST_CLIENT_ID;
const CLIENT_SECRET = process.env.PINTEREST_CLIENT_SECRET;
const REDIRECT_URI = process.env.PINTEREST_REDIRECT_URI;
const SESSION_SECRET = process.env.SESSION_SECRET;
const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
const CORS_ORIGIN = new URL(FRONTEND_URL).origin;

const isProduction = process.env.NODE_ENV === "production";

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI || !SESSION_SECRET) {
  console.error(
    "Missing required environment variables. Check PINTEREST_CLIENT_ID, PINTEREST_CLIENT_SECRET, PINTEREST_REDIRECT_URI, SESSION_SECRET."
  );
  process.exit(1);
}

if (!FRONTEND_URL) {
  console.error("Missing FRONTEND_URL environment variable. Set it to the deployed frontend origin.");
  process.exit(1);
}

// Pinterest API endpoints
const PINTEREST_OAUTH_URL = "https://www.pinterest.com/oauth/";
const PINTEREST_TOKEN_URL = "https://api.pinterest.com/v5/oauth/token";
const PINTEREST_API_BASE = "https://api.pinterest.com/v5";

// Required OAuth scopes for this demo
const SCOPES = ["boards:read", "boards:write", "pins:read", "pins:write"].join(",");

// ─── Middleware ───
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Session configuration ───
// In production (GitHub Pages frontend on different origin):
//   - SameSite=None is required so the cookie is sent on cross-origin requests from the frontend
//   - Secure=true is required by browsers when SameSite=None
// In development:
//   - SameSite="lax" is sufficient for localhost
app.use(
  session({
    name: "mlh.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
    }
  })
);

// ─── CORS ───
// Only allow the actual frontend origin.
// Production: https://shehrozali6465372-ctrl.github.io
// Development: localhost origins
const allowedOrigins = [
  CORS_ORIGIN,
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:8000",
  "http://localhost:3000",
  "http://localhost:8080"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const isAllowed = origin && allowedOrigins.includes(origin);

  if (isAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") {
    return isAllowed ? res.sendStatus(204) : res.status(403).json({ error: "Origin not allowed" });
  }
  next();
});

// ─── Auth helpers ───

/** Get the authenticated user's saved Pinterest token (server-side). */
function getUserToken(req) {
  if (!req.session.pinterest) return null;
  return req.session.pinterest.access_token || null;
}

/** Create a secure random state value for OAuth CSRF protection. */
function createState() {
  return crypto.randomBytes(32).toString("hex");
}

/** Build the Pinterest OAuth authorization URL. */
function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    state
  });
  return `${PINTEREST_OAUTH_URL}?${params.toString()}`;
}

// ─── Routes ───

// Health check — safe diagnostics, never exposes secrets
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "modern-living-hub-backend",
    pinterest_client_id_configured: Boolean(CLIENT_ID),
    redirect_uri_configured: Boolean(REDIRECT_URI),
    frontend_url_configured: Boolean(FRONTEND_URL),
    production_mode: isProduction
  });
});

// ─── Step 1: Start OAuth — GET /auth/pinterest ───
app.get("/auth/pinterest", (req, res) => {
  const state = createState();
  req.session.oauth_state = state;
  req.session.save((err) => {
    if (err) {
      console.error("Session save error:", err.message);
      return res.status(500).json({ error: "Could not start authentication." });
    }
    res.redirect(buildAuthUrl(state));
  });
});

// ─── Step 2: OAuth callback — GET /auth/pinterest/callback ───
app.get("/auth/pinterest/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // Handle OAuth denial
  if (error) {
    const msg =
      error === "access_denied"
        ? "You denied the Pinterest authorization request."
        : error_description || "Pinterest authorization failed.";
    return res.redirect(`${FRONTEND_URL}/pinterest.html?pinterest_error=${encodeURIComponent(msg)}`);
  }

  if (!code || !state) {
    return res.redirect(`${FRONTEND_URL}/pinterest.html?pinterest_error=Missing authorization code or state.`);
  }

  // Validate state (CSRF protection)
  if (!req.session.oauth_state || state !== req.session.oauth_state) {
    return res.redirect(`${FRONTEND_URL}/pinterest.html?pinterest_error=Invalid OAuth state. Please try again.`);
  }
  delete req.session.oauth_state;

  try {
    // Exchange authorization code for access token
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: code.toString(),
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    });

    const tokenRes = await fetch(PINTEREST_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    const tokenData = await tokenRes.json().catch(() => ({}));

    if (!tokenRes.ok) {
      console.error("Token exchange failed:", tokenRes.status);
      return res.redirect(`${FRONTEND_URL}/pinterest.html?pinterest_error=${encodeURIComponent("Could not exchange authorization code for access token.")}`);
    }

    if (!tokenData.access_token) {
      return res.redirect(`${FRONTEND_URL}/pinterest.html?pinterest_error=No access token returned by Pinterest.`);
    }

    // Store the token server-side only
    req.session.pinterest = {
      access_token: tokenData.access_token,
      token_type: tokenData.token_type || "bearer",
      connected_at: new Date().toISOString()
    };
    req.session.save(() => {
      res.redirect(`${FRONTEND_URL}/pinterest.html?pinterest_connected=1`);
    });
  } catch (err) {
    console.error("OAuth callback error:", err.message);
    res.redirect(`${FRONTEND_URL}/pinterest.html?pinterest_error=${encodeURIComponent("Network error during Pinterest authentication.")}`);
  }
});

// ─── Step 3: OAuth status — GET /api/pinterest/status ───
app.get("/api/pinterest/status", (req, res) => {
  const token = getUserToken(req);
  if (!token) {
    return res.json({ connected: false });
  }
  res.json({ connected: true, connected_at: req.session.pinterest.connected_at });
});

// ─── Step 4: Disconnect — POST /api/pinterest/disconnect ───
app.post("/api/pinterest/disconnect", (req, res) => {
  if (req.session.pinterest) {
    delete req.session.pinterest;
  }
  req.session.save(() => {
    res.json({ disconnected: true });
  });
});

// ─── Step 5: Get user's boards — GET /api/pinterest/boards ───
app.get("/api/pinterest/boards", async (req, res) => {
  const token = getUserToken(req);
  if (!token) {
    return res.status(401).json({ error: "Not connected to Pinterest." });
  }

  try {
    const apiRes = await fetch(`${PINTEREST_API_BASE}/boards`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    const data = await apiRes.json().catch(() => ({}));

    if (!apiRes.ok) {
      return handleApiError(apiRes.status, res);
    }

    res.json({ boards: data.items || [] });
  } catch (err) {
    console.error("Board fetch error:", err.message);
    res.status(502).json({ error: "Could not reach Pinterest API." });
  }
});

// ─── Step 6: Create a Pin — POST /api/pinterest/pins ───
app.post("/api/pinterest/pins", async (req, res) => {
  const token = getUserToken(req);
  if (!token) {
    return res.status(401).json({ error: "Not connected to Pinterest." });
  }

  const { board_id, title, description, image_url, destination_url } = req.body;

  // Validate required fields
  if (!board_id || !title || !image_url || !destination_url) {
    return res.status(400).json({
      error: "Board, title, image URL, and destination URL are required."
    });
  }

  const pinData = {
    board_id: board_id.toString(),
    title: title.toString(),
    description: (description || "").toString(),
    media_source: {
      source_type: "image_url",
      url: image_url.toString()
    },
    link: destination_url.toString()
  };

  try {
    const apiRes = await fetch(`${PINTEREST_API_BASE}/pins`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(pinData)
    });

    const data = await apiRes.json().catch(() => ({}));

    if (!apiRes.ok) {
      return handleApiError(apiRes.status, res);
    }

    res.json({
      success: true,
      pin: {
        id: data.id,
        title: data.title,
        link: data.link,
        board_id: data.board_id,
        created_at: data.created_at
      }
    });
  } catch (err) {
    console.error("Pin creation error:", err.message);
    res.status(502).json({ error: "Could not reach Pinterest API." });
  }
});

// ─── Step 7: Create a Board — POST /api/pinterest/boards ───
app.post("/api/pinterest/boards", async (req, res) => {
  const token = getUserToken(req);
  if (!token) {
    return res.status(401).json({ error: "Not connected to Pinterest." });
  }

  const { name, description } = req.body;

  if (!name) {
    return res.status(400).json({ error: "Board name is required." });
  }

  const boardData = {
    name: name.toString(),
    description: (description || "").toString()
  };

  try {
    const apiRes = await fetch(`${PINTEREST_API_BASE}/boards`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(boardData)
    });

    const data = await apiRes.json().catch(() => ({}));

    if (!apiRes.ok) {
      return handleApiError(apiRes.status, res);
    }

    res.json({
      success: true,
      board: {
        id: data.id,
        name: data.name,
        description: data.description
      }
    });
  } catch (err) {
    console.error("Board creation error:", err.message);
    res.status(502).json({ error: "Could not reach Pinterest API." });
  }
});

// ─── API error handling helper ───
function handleApiError(status, res) {
  switch (status) {
    case 400:
      return res.status(400).json({ error: "Pinterest rejected the request. Check the input values and try again." });
    case 401:
      return res.status(401).json({ error: "Pinterest token is invalid or expired. Please disconnect and reconnect." });
    case 403:
      return res.status(403).json({ error: "Pinterest permission is missing for this action. Verify the app scopes are correct." });
    case 404:
      return res.status(404).json({ error: "Pinterest resource not found. It may have been deleted." });
    case 429:
      return res.status(429).json({ error: "Pinterest rate limit reached. Please wait and try again." });
    default:
      if (status >= 500) {
        return res.status(502).json({ error: "Pinterest API is experiencing issues. Please try again later." });
      }
      return res.status(status).json({ error: `Pinterest API error (${status}). Please try again.` });
  }
}

// ─── Start server ───
app.listen(PORT, () => {
  console.log(`Modern Living Hub backend running on http://localhost:${PORT}`);
  console.log(`Pinterest OAuth redirect URI: ${REDIRECT_URI}`);
  console.log(`Frontend URL: ${FRONTEND_URL}`);
  console.log(`CORS origin:   ${CORS_ORIGIN}`);
  console.log(`Production mode: ${isProduction}`);
});
