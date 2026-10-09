/**
 * Modern Living Hub — Pinterest OAuth Backend
 * Node.js + Express backend for real Pinterest OAuth 2.0 and API v5 integration.
 *
 * Environment variables (never hard-coded):
 *   PINTEREST_CLIENT_ID     — Pinterest app client ID
 *   PINTEREST_CLIENT_SECRET — Pinterest app client secret (server-side only)
 *   PINTEREST_REDIRECT_URI  — Exact callback URL registered with Pinterest
 *   SESSION_SECRET          — Secret for express-session
 *   FRONTEND_URL            — Full deployed frontend base URL including project path (e.g. https://modernlivinghub.vercel.app)
 */

import express from "express";
import cookieSession from "cookie-session";
import crypto from "node:crypto";
import cookieParser from "cookie-parser";
import "dotenv/config";
import { listPinterestAccounts, registerPinterestAccount, storePinterestCredential, pinterestOperation, revokePinterestCredential, warmUcosService } from "./ucos-credential-client.js";

const app = express();
const PORT = Number(process.env.PORT) || 10000;

// ─── Required environment variables ───
const CLIENT_ID = process.env.PINTEREST_CLIENT_ID;
const CLIENT_SECRET = process.env.PINTEREST_CLIENT_SECRET;
const REDIRECT_URI = process.env.PINTEREST_REDIRECT_URI;
const SESSION_SECRET = process.env.SESSION_SECRET;
const configuredFrontendUrl = (process.env.FRONTEND_URL || "").trim();
const FRONTEND_URL = (configuredFrontendUrl || "https://modernlivinghub.vercel.app")
  .replace(/\/+$/, "");
const CORS_ORIGIN = new URL(FRONTEND_URL).origin;

const isProduction = process.env.NODE_ENV === "production";

// ─── Sandbox configuration (temporary testing) ───
// Set PINTEREST_SANDBOX_TOKEN and PINTEREST_API_BASE_URL in environment
// to test against Pinterest Sandbox instead of production.
// To switch back to production: remove these env vars or set them to empty.
const SANDBOX_TOKEN = process.env.PINTEREST_SANDBOX_TOKEN || null;
const SANDBOX_API_BASE = process.env.PINTEREST_API_BASE_URL || null;
const isSandbox = Boolean(SANDBOX_TOKEN && SANDBOX_API_BASE);

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

/** Get the effective API base URL (sandbox or production). */
function getApiBaseUrl() {
  return isSandbox ? SANDBOX_API_BASE : PINTEREST_API_BASE;
}

// Required OAuth scopes for this demo
const SCOPES = ["boards:read", "boards:write", "pins:read", "pins:write", "user_accounts:read"].join(",");
const REQUIRED_SCOPES = SCOPES.split(",");

// ─── Middleware ───
app.set("trust proxy", 1);
app.use(express.json({ limit: "100mb" })); // raised for TikTok Direct Post base64 video uploads
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(SESSION_SECRET));

// ─── Session configuration (cookie-session) ───
// Stores the entire session in a signed cookie — no server-side state.
// This survives Render free tier hibernation between OAuth callback and
// the subsequent cross-origin API request from the Vercel frontend.
app.use(
  cookieSession({
    name: "mlh.sid",
    keys: [SESSION_SECRET],
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    secure: isProduction,
    httpOnly: true,
    sameSite: isProduction ? "none" : "lax"
  })
);
// Security: the signed HttpOnly cookie contains only non-secret session identifiers.\n// Raw Pinterest access/refresh tokens are stored only in UCOS L13 encrypted PostgreSQL.\n\n// ─── CORS ───
// Only allow the actual frontend origin.
// Production: https://modernlivinghub.vercel.app
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  if (req.method === "OPTIONS") {
    return isAllowed ? res.sendStatus(204) : res.status(403).json({ error: "Origin not allowed" });
  }
  next();
});

// ─── UCOS-backed Pinterest credential boundary ───
const handoffStore = new Map();
const HANDOFF_TTL_MS = 5 * 60 * 1000;
const sessionTokenStore = new Map();
const SESSION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function createHandoff(accountId) {
  const code = crypto.randomBytes(32).toString("hex");
  handoffStore.set(code, { accountId, expiresAt: Date.now() + HANDOFF_TTL_MS });
  return code;
}
function consumeHandoff(code) {
  const entry = handoffStore.get(code);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { handoffStore.delete(code); return null; }
  handoffStore.delete(code); return entry;
}
function createSessionToken(accountId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessionTokenStore.set(token, { accountId, expiresAt: Date.now() + SESSION_TOKEN_TTL_MS });
  return token;
}
function getAccountId(req) {
  const h = req.headers.authorization;
  if (h && h.startsWith("Bearer ")) {
    const entry = sessionTokenStore.get(h.slice(7));
    if (entry) {
      if (Date.now() > entry.expiresAt) sessionTokenStore.delete(h.slice(7));
      else return entry.accountId;
    }
  }
  return req.session?.pinterestAccountId || null;
}
async function fetchPinterestUser(accessToken) {
  const response = await fetch(`${PINTEREST_API_BASE}/user_account`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) throw new Error("Pinterest user account lookup failed");
  return data;
}
async function persistPinterestCredential(tokenData) {
  // Tokens must be persisted by UCOS L13; never fall back to an MLH-local store.
  console.info("[pinterest] access token exchanged; validating Pinterest identity");
  const user = await fetchPinterestUser(tokenData.access_token);
  const accounts = await listPinterestAccounts();
  const configuredAccountId = String(process.env.UCOS_PINTEREST_ACCOUNT_ID || "").trim();
  let account = configuredAccountId
    ? accounts.find(a => String(a.account_id || "") === configuredAccountId)
    : accounts.find(a =>
        String(a.platform_account_id || "") === String(user.id) ||
        String(a.external_account_id || "") === String(user.id)
      );

  if (!account) {
    if (configuredAccountId) {
      throw new Error("UCOS_PINTEREST_ACCOUNT_ID does not identify a registered Pinterest account");
    }
    console.info("[pinterest] no matching account; provisioning canonical UCOS account", JSON.stringify({ pinterest_user_id: String(user.id || ""), username: String(user.username || "") }));
    await registerPinterestAccount(user);
    const refreshedAccounts = await listPinterestAccounts();
    account = refreshedAccounts.find(a =>
      String(a.platform_account_id || "") === String(user.id) ||
      String(a.external_account_id || "") === String(user.id)
    );
    if (!account) {
      throw new Error("UCOS account registration returned but the canonical Pinterest account was not visible on read-back");
    }
  }
  if (String(account.platform || "").toLowerCase() !== "pinterest" || account.enabled === false) {
    throw new Error("Matched UCOS account is not an enabled Pinterest account");
  }
  if (String(account.platform_account_id || "") !== String(user.id) &&
      String(account.external_account_id || "") !== String(user.id)) {
    throw new Error("Configured UCOS account identity does not match the authorized Pinterest user");
  }
  if (!String(account.credentials_ref || "").trim()) {
    throw new Error("Matched UCOS Pinterest account has no credential reference");
  }

  console.info("[pinterest] canonical UCOS account matched; writing credential to L13 vault");
  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
    : null;
  const vaultResult = await storePinterestCredential({
    account_id: account.account_id,
    platform_account_id: account.platform_account_id,
    credential_ref: account.credentials_ref,
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || "",
    token_type: tokenData.token_type || "bearer",
    scope: tokenData.scope || SCOPES,
    pinterest_user_id: user.id,
    username: user.username || "",
    expires_at: expiresAt,
    refresh_token_expires_at: tokenData.refresh_token_expires_at
      ? new Date(Number(tokenData.refresh_token_expires_at) * 1000).toISOString()
      : tokenData.refresh_token_expires_in
        ? new Date(Date.now() + Number(tokenData.refresh_token_expires_in) * 1000).toISOString()
        : null
  });
  if (vaultResult?.data?.stored !== true) {
    console.error("[pinterest] UCOS did not confirm credential persistence");
    throw new Error("UCOS credential vault did not confirm storage");
  }
  console.info("[pinterest] credential successfully stored in UCOS L13 vault");
  return { account, user };
}
function createState() { return crypto.randomBytes(32).toString("hex"); }
function buildAuthUrl(state, prompt) {
  const params = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: SCOPES, state });
  if (prompt) params.set("prompt", prompt);
  return `${PINTEREST_OAUTH_URL}?${params.toString()}`;
}

// ─── Routes ───
app.get("/api/health", (req, res) => {
  res.json({ status:"ok", service:"modern-living-hub-backend", pinterest_client_id_configured:Boolean(CLIENT_ID), redirect_uri_configured:Boolean(REDIRECT_URI), frontend_url_configured:Boolean(FRONTEND_URL), ucos_vault_configured:Boolean(process.env.UCOS_API_TOKEN), production_mode:isProduction, sandbox_mode:isSandbox });
});
app.get("/auth/pinterest", (req,res) => {
  const state=createState(); if(!req.session.sessionId) req.session.sessionId=crypto.randomUUID(); req.session.oauth_state=state;
  res.cookie("mlh.oauth_state",state,{httpOnly:true,secure:isProduction,sameSite:isProduction?"none":"lax",maxAge:600000,signed:true});
  // Start waking the UCOS Free service before the user spends time on Pinterest consent.
  // Do not block the redirect: the warm-up continues in the background.
  void warmUcosService().catch(err => console.warn("[pinterest] UCOS pre-warm failed", String(err?.message || err)));
  res.redirect(buildAuthUrl(state,req.query.prompt||null));
});
app.get("/auth/pinterest/callback", async (req,res) => {
  const {code,state,error,error_description}=req.query;
  const cookieState=req.signedCookies["mlh.oauth_state"]||null;
  if(error){res.clearCookie("mlh.oauth_state");return res.redirect(`${FRONTEND_URL}/pinterest.html?pinterest_error=${encodeURIComponent(error==="access_denied"?"You denied the Pinterest authorization request.":error_description||"Pinterest authorization failed.")}`);}
  if(!code||!state){res.clearCookie("mlh.oauth_state");return res.redirect(`${FRONTEND_URL}/pinterest.html?pinterest_error=Missing authorization code or state.`);}
  const sessionState=req.session.oauth_state||null;
  if(!((sessionState&&state===sessionState)||(cookieState&&state===cookieState))){res.clearCookie("mlh.oauth_state");return res.redirect(`${FRONTEND_URL}/pinterest.html?pinterest_error=Invalid OAuth state. Please try again.`);}
  delete req.session.oauth_state; res.clearCookie("mlh.oauth_state");
  try {
    const basic=Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    const body=new URLSearchParams({grant_type:"authorization_code",code:code.toString(),redirect_uri:REDIRECT_URI});
    const tokenRes=await fetch(PINTEREST_TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Authorization:`Basic ${basic}`},body:body.toString()});
    const tokenData=await tokenRes.json().catch(()=>({}));
    if(!tokenRes.ok||!tokenData.access_token){
      // Log only Pinterest error metadata, never credentials, code, or token values.
      const safeError = String(tokenData.error || tokenData.message || tokenData.error_description || `HTTP ${tokenRes.status}`).slice(0, 180);
      console.error("[pinterest] token exchange rejected", JSON.stringify({ status: tokenRes.status, error: safeError }));
      const detail = tokenRes.status === 401
        ? "Pinterest returned HTTP 401 during token exchange. Verify the Render Pinterest client ID and secret belong to the same app, and retry with a fresh authorization code."
        : tokenData.error_description || `HTTP ${tokenRes.status}`;
      return res.redirect(`${FRONTEND_URL}/pinterest.html?pinterest_error=${encodeURIComponent("Could not exchange authorization code: "+detail)}`);
    }
    const stored=await persistPinterestCredential(tokenData);
    req.session.pinterestAccountId=stored.account.account_id;
    const handoffCode=createHandoff(stored.account.account_id);
    res.redirect(`${FRONTEND_URL}/pinterest.html?pinterest_connected=1&handoff=${handoffCode}`);
  } catch(err) {
    // Log the failure stage and a sanitized message only; never log OAuth tokens.
    console.error("[pinterest] OAuth callback failed:", err?.message || "unknown error");
    res.redirect(`${FRONTEND_URL}/pinterest.html?pinterest_error=${encodeURIComponent(err?.message||"Pinterest authentication failed.")}`);
  }
});
app.get("/api/pinterest/status",async(req,res)=>{
  const accountId=getAccountId(req); if(!accountId)return res.json({connected:false});
  try{const result=await pinterestOperation(accountId,"account");res.json({connected:true,id:result?.data?.id||null,username:result?.data?.username||null});}
  catch{res.json({connected:false,needs_reauth:true});}
});
app.post("/api/pinterest/complete",async(req,res)=>{
  const {handoff}=req.body; if(!handoff||typeof handoff!=="string")return res.status(400).json({error:"Missing handoff code."});
  const entry=consumeHandoff(handoff); if(!entry)return res.status(400).json({error:"Invalid or expired handoff code."});
  try{await pinterestOperation(entry.accountId,"account");res.json({connected:true,session_token:createSessionToken(entry.accountId)});}
  catch{res.status(400).json({error:"Pinterest credentials are not available in UCOS. Please reconnect."});}
});
// Canonical account inventory is intentionally not exposed through an unauthenticated MLH endpoint.
// The OAuth callback uses the server-to-server UCOS credential client directly.
app.post("/api/pinterest/disconnect",async(req,res)=>{
  const accountId=getAccountId(req);
  if(accountId){try{const accounts=await listPinterestAccounts();const account=accounts.find(a=>a.account_id===accountId);if(account?.credentials_ref)await revokePinterestCredential(accountId,account.credentials_ref);}catch(err){console.error("Pinterest credential revoke failed:",err?.message||String(err));}
    for(const [token,entry] of sessionTokenStore.entries())if(entry.accountId===accountId)sessionTokenStore.delete(token);}
  delete req.session.pinterestAccountId; delete req.session.oauth_state; res.json({disconnected:true});
});
app.get("/api/pinterest/boards",async(req,res)=>{
  const accountId=getAccountId(req);if(!accountId)return res.status(401).json({error:"Not connected to Pinterest."});
  try{const result=await pinterestOperation(accountId,"boards");res.json({boards:result?.data?.items||[]});}
  catch{res.status(502).json({error:"Could not reach Pinterest API through UCOS."});}
});
app.get("/api/pinterest/account",async(req,res)=>{
  const accountId=getAccountId(req);if(!accountId)return res.status(401).json({error:"Not connected to Pinterest."});
  try{const result=await pinterestOperation(accountId,"account");const data=result?.data||{};res.json({connected:true,id:data.id||null,username:data.username||null,display_name:data.display_name||null,profile_image:data.profile_image||null,website_url:data.website_url||null});}
  catch{res.status(401).json({error:"Pinterest credential is invalid or expired. Please reconnect."});}
});
app.post("/api/pinterest/pins",async(req,res)=>{
  const accountId=getAccountId(req);if(!accountId)return res.status(401).json({error:"Not connected to Pinterest."});
  const {board_id,title,description,image_url,destination_url}=req.body;
  if(!board_id||!title||!image_url||!destination_url)return res.status(400).json({error:"Board, title, image URL, and destination URL are required."});
  try{const result=await pinterestOperation(accountId,"create_pin",{board_id:String(board_id),title:String(title),description:String(description||""),image_url:String(image_url),destination_url:String(destination_url)});const data=result?.data||{};res.json({success:true,pin:{id:data.id,title:data.title,link:data.link,board_id:data.board_id,created_at:data.created_at}});}
  catch(err){res.status(502).json({error:err?.message||"Pinterest rejected the Pin request."});}
});
app.post("/api/pinterest/boards",async(req,res)=>{
  const accountId=getAccountId(req);if(!accountId)return res.status(401).json({error:"Not connected to Pinterest."});
  const {name,description}=req.body;if(!name)return res.status(400).json({error:"Board name is required."});
  try{const result=await pinterestOperation(accountId,"create_board",{name:String(name),description:String(description||"")});const data=result?.data||{};res.json({success:true,board:{id:data.id,name:data.name,description:data.description}});}
  catch(err){res.status(502).json({error:err?.message||"Pinterest rejected the board request."});}
});

// ─── API error handling helper ───
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

// ─── TikTok integration (isolated module) ───
import { registerTikTokRoutes } from "./tiktok.js";
registerTikTokRoutes(app, { SESSION_SECRET, FRONTEND_URL, isProduction });

// ─── YouTube integration (isolated module) ───
import { registerYouTubeRoutes } from "./youtube.js";
registerYouTubeRoutes(app, { SESSION_SECRET, FRONTEND_URL, isProduction });

// ─── Start server ───
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Modern Living Hub backend running on http://0.0.0.0:${PORT}`);
  console.log(`Pinterest OAuth redirect URI: ${REDIRECT_URI}`);
  console.log(`Frontend URL: ${FRONTEND_URL}`);
  console.log(`CORS origin:   ${CORS_ORIGIN}`);
  console.log(`Production mode: ${isProduction}`);
});
