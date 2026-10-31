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
// Security: the signed HttpOnly cookie contains only non-secret session identifiers.\n// Raw Pinterest access/refresh tokens are stored only in Pinterest Agent Neon database.\n\n// ─── CORS ───
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

// ─── Pinterest Agent-backed credential boundary ───
const handoffStore = new Map();
const HANDOFF_TTL_MS = 5 * 60 * 1000;
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
// Signed, stateless Hub session tokens survive Render restarts and work across
// instances. They contain only an account ID and expiry, never Pinterest tokens.
// Pinterest credentials remain encrypted in the Agent's Neon database.
function signSessionPayload(encodedPayload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(encodedPayload).digest("base64url");
}
function createSessionToken(accountId) {
  const payload = Buffer.from(JSON.stringify({
    accountId,
    expiresAt: Date.now() + SESSION_TOKEN_TTL_MS,
    nonce: crypto.randomBytes(16).toString("hex"),
  })).toString("base64url");
  return `${payload}.${signSessionPayload(payload)}`;
}
function readSessionToken(token) {
  if (typeof token !== "string") return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;
  const payload = token.slice(0, separator);
  const suppliedSignature = token.slice(separator + 1);
  const expectedSignature = signSessionPayload(payload);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const entry = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof entry.accountId !== "string" || !entry.accountId.startsWith("pinterest:") ||
        !Number.isFinite(entry.expiresAt) || Date.now() >= entry.expiresAt) return null;
    return entry.accountId;
  } catch {
    return null;
  }
}
function getAccountId(req) {
  const h = req.headers.authorization;
  if (h && h.startsWith("Bearer ")) {
    const accountId = readSessionToken(h.slice(7));
    if (accountId) return accountId;
  }
  return req.session?.pinterestAccountId || null;
}
async function fetchPinterestUser(accessToken) {
  const response = await fetch(`${PINTEREST_API_BASE}/user_account`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) throw new Error("Pinterest user account lookup failed");
  return data;
}
async function agentRequest(path, options = {}) {
  const base = String(process.env.PINTEREST_AGENT_API_URL || "").trim().replace(/\/+$/, "");
  const key = String(process.env.PINTEREST_AGENT_INGEST_KEY || "").trim();
  if (!base || !key) throw new Error("Pinterest Agent API is not configured.");
  const retryTransient = options.retryTransient === true;
  const requestOptions = { ...options };
  delete requestOptions.retryTransient;
  let lastError;
  const delays = retryTransient ? [0, 5000, 10000, 15000, 20000, 25000] : [0];
  for (const delay of delays) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const response = await fetch(`${base}${path}`, { ...requestOptions, headers: { "Content-Type": "application/json", "X-Credential-Ingest-Key": key, ...(options.headers || {}) }, signal: AbortSignal.timeout(15000) });
      const body = await response.json().catch(() => ({}));
      if (response.ok) return body;
      if (retryTransient && [502, 503, 504].includes(response.status)) {
        // Retry based on the HTTP status, not the response body: a sanitized
        // detail string often omits "HTTP 503" even when the status is transient.
        lastError = new Error(`Agent API HTTP ${response.status}`);
        lastError.status = response.status;
        continue;
      }
      const error = new Error(String(body.detail || body.error || `Agent API HTTP ${response.status}`));
      error.status = response.status;
      throw error;
    } catch (err) {
      lastError = err;
      if (!retryTransient || !/fetch failed|ECONNRESET|ETIMEDOUT|timeout|aborted|AbortError|TimeoutError|HTTP 502|HTTP 503|HTTP 504/i.test(String(err?.message || err))) throw err;
    }
  }
  throw lastError || new Error("Pinterest Agent is still starting. Please retry.");
}
async function waitForPinterestAgentReady() {
  const base = String(process.env.PINTEREST_AGENT_API_URL || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("Pinterest Agent API is not configured.");
  const timeoutMs = Math.max(100, Number(process.env.PINTEREST_AGENT_READY_TIMEOUT_MS) || 90000);
  const retryDelayMs = Math.max(1, Number(process.env.PINTEREST_AGENT_READY_RETRY_MS) || 5000);
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(Math.min(10000, timeoutMs))
      });
      const health = await response.json().catch(() => ({}));
      if (response.ok && health?.status === "ok") return;
      lastError = new Error(`Pinterest Agent health check HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    if (Date.now() + retryDelayMs >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
  }
  const reason = String(lastError?.message || "health check timed out").slice(0, 160);
  throw new Error(`Pinterest Agent did not become healthy within ${Math.round(timeoutMs / 1000)} seconds (${reason}). Please retry Connect Pinterest when the Agent is healthy.`);
}

async function persistPinterestCredential(tokenData) {
  // Render free instances may be asleep; wake and verify the Agent before sending OAuth credentials.
  await waitForPinterestAgentReady();
  const user = await fetchPinterestUser(tokenData.access_token);
  const expiresAt = tokenData.expires_in ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString() : null;
  const accountId = `pinterest:${String(user.id)}`;
  const saved = await agentRequest("/integrations/pinterest/credentials", { retryTransient:true, method:"POST", body:JSON.stringify({
    account_id:accountId, pinterest_user_id:String(user.id), username:String(user.username || ""),
    access_token:String(tokenData.access_token), refresh_token:String(tokenData.refresh_token || ""),
    token_type:String(tokenData.token_type || "bearer"), scope:String(tokenData.scope || SCOPES), expires_at:expiresAt,
    refresh_token_expires_at:tokenData.refresh_token_expires_at ? new Date(Number(tokenData.refresh_token_expires_at)*1000).toISOString() : tokenData.refresh_token_expires_in ? new Date(Date.now()+Number(tokenData.refresh_token_expires_in)*1000).toISOString() : null
  })});
  if (saved?.stored !== true) throw new Error("Pinterest Agent did not confirm encrypted Neon credential storage.");
  return { account:{account_id:accountId}, user };
}
async function persistPinterestCredentialWithRetry(tokenData) { return persistPinterestCredential(tokenData); }

function createState() { return crypto.randomBytes(32).toString("hex"); }
function buildAuthUrl(state, prompt) {
  const params = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: SCOPES, state });
  if (prompt) params.set("prompt", prompt);
  return `${PINTEREST_OAUTH_URL}?${params.toString()}`;
}

// ─── Routes ───
app.get("/api/health", (req,res) => res.json({status:"ok",service:"modern-living-hub-backend",agent_configured:Boolean(process.env.PINTEREST_AGENT_API_URL&&process.env.PINTEREST_AGENT_INGEST_KEY),pinterest_client_id_configured:Boolean(CLIENT_ID),redirect_uri_configured:Boolean(REDIRECT_URI)}));
app.get("/auth/pinterest", async (req,res) => {
  if (!process.env.PINTEREST_AGENT_API_URL || !process.env.PINTEREST_AGENT_INGEST_KEY) return res.redirect(`${FRONTEND_URL}/pinterest.html?pinterest_error=${encodeURIComponent("Pinterest Agent API is not configured.")}`);
  const state=createState(); if(!req.session.sessionId)req.session.sessionId=crypto.randomUUID(); req.session.oauth_state=state;
  res.cookie("mlh.oauth_state",state,{httpOnly:true,secure:isProduction,sameSite:isProduction?"none":"lax",maxAge:600000,signed:true});
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
    // Authorization codes are single-use. Verify the downstream credential store
    // is reachable BEFORE exchanging the code, otherwise an Agent outage consumes
    // the code and leaves us unable to complete the connection without fresh consent.
    await waitForPinterestAgentReady();
    const basic=Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    const body=new URLSearchParams({grant_type:"authorization_code",code:code.toString(),redirect_uri:REDIRECT_URI,continuous_refresh:"true"});
    const tokenRes=await fetch(PINTEREST_TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Authorization:`Basic ${basic}`},body:body.toString()});
    const tokenData=await tokenRes.json().catch(()=>({}));
    if(!tokenRes.ok||!tokenData.access_token){
      // Log only Pinterest error metadata, never credentials, code, or token values.
      const safeError = String(tokenData.error || tokenData.message || tokenData.error_description || `HTTP ${tokenRes.status}`).slice(0, 180);
      console.error("[pinterest] token exchange rejected", JSON.stringify({ status: tokenRes.status, error: safeError }));
      const grantError = /authorization grant is invalid|invalid_grant|authorization code.*(invalid|expired|used)/i.test(safeError);
      const clientError = /invalid client|client authentication|unauthorized client|invalid_client/i.test(safeError);
      const detail = grantError
        ? "Pinterest rejected this authorization code because it is invalid, expired, or already used. Start a new Connect Pinterest flow; do not refresh or reuse the callback URL."
        : clientError
          ? "Pinterest rejected client authentication. Verify PINTEREST_CLIENT_ID and PINTEREST_CLIENT_SECRET are the matching credentials for the same Pinterest app in Render."
          : tokenData.error_description || safeError || `HTTP ${tokenRes.status}`;
      return res.redirect(`${FRONTEND_URL}/pinterest.html?pinterest_error=${encodeURIComponent("Could not exchange authorization code: "+detail)}`);
    }
    const stored=await persistPinterestCredentialWithRetry(tokenData);
    req.session.pinterestAccountId=stored.account.account_id;
    const handoffCode=createHandoff(stored.account.account_id);
    res.redirect(`${FRONTEND_URL}/pinterest.html?pinterest_connected=1&handoff=${handoffCode}`);
  } catch(err) {
    // Log the failure stage and a sanitized message only; never log OAuth tokens.
    console.error("[pinterest] OAuth callback failed:", err?.message || "unknown error");
    res.redirect(`${FRONTEND_URL}/pinterest.html?pinterest_error=${encodeURIComponent(err?.message||"Pinterest authentication failed.")}`);
  }
});
async function pinterestOp(accountId,operation,payload={}) {
  const retryTransient = ["account","boards"].includes(operation);
  const request = () => agentRequest("/integrations/pinterest/operation",{
    retryTransient, method:"POST", body:JSON.stringify({account_id:accountId,operation,payload})
  });
  try {
    return await request();
  } catch (err) {
    // A 401 from the Agent means the stored Pinterest access token was rejected.
    // Refresh once through the trusted server-to-server boundary, then retry the
    // original operation exactly once. Never refresh or retry a disconnect.
    if (err?.status !== 401 || operation === "disconnect") throw err;
    // OAuth refresh can rotate and invalidate the submitted refresh token. A
    // timeout/5xx may be an ambiguous outcome, so never automatically replay
    // this non-idempotent POST; let the caller reconcile or reconnect instead.
    await agentRequest("/integrations/pinterest/refresh",{
      method:"POST",
      body:JSON.stringify({account_id:accountId,client_id:CLIENT_ID,client_secret:CLIENT_SECRET})
    });
    return request();
  }
}
app.get("/api/pinterest/status",async(req,res)=>{const id=getAccountId(req);if(!id)return res.json({connected:false});try{const r=await pinterestOp(id,"account");res.json({connected:true,id:r.data?.id||null,username:r.data?.username||null});}catch{res.json({connected:false,needs_reauth:true});}});
app.post("/api/pinterest/complete",async(req,res)=>{const {handoff}=req.body;if(!handoff||typeof handoff!=="string")return res.status(400).json({error:"Missing handoff code."});const e=consumeHandoff(handoff);if(!e)return res.status(400).json({error:"Invalid or expired handoff code."});try{await pinterestOp(e.accountId,"account");res.json({connected:true,session_token:createSessionToken(e.accountId)});}catch{return res.status(400).json({error:"Agent Neon credential unavailable; reconnect Pinterest."});}});
app.post("/api/pinterest/disconnect",async(req,res)=>{const id=getAccountId(req);if(id){try{await pinterestOp(id,"disconnect");}catch{return res.status(502).json({error:"Agent could not confirm disconnect."});}}delete req.session.pinterestAccountId;delete req.session.oauth_state;res.json({disconnected:true});});
app.get("/api/pinterest/boards",async(req,res)=>{const id=getAccountId(req);if(!id)return res.status(401).json({error:"Not connected to Pinterest."});try{const r=await pinterestOp(id,"boards");res.json({boards:r.data?.items||[]});}catch{return res.status(502).json({error:"Could not reach Pinterest through Agent."});}});
app.get("/api/pinterest/account",async(req,res)=>{const id=getAccountId(req);if(!id)return res.status(401).json({error:"Not connected to Pinterest."});try{const r=await pinterestOp(id,"account");const d=r.data||{};res.json({connected:true,id:d.id||null,username:d.username||null,display_name:d.display_name||null,profile_image:d.profile_image||null,website_url:d.website_url||null});}catch{return res.status(401).json({error:"Pinterest credential invalid or expired; reconnect."});}});
app.post("/api/pinterest/pins",async(req,res)=>{const id=getAccountId(req);if(!id)return res.status(401).json({error:"Not connected to Pinterest."});const {board_id,title,description,image_url,destination_url}=req.body;if(!board_id||!title||!image_url||!destination_url)return res.status(400).json({error:"Board, title, image URL, and destination URL are required."});try{const r=await pinterestOp(id,"create_pin",{board_id:String(board_id),title:String(title),description:String(description||""),image_url:String(image_url),destination_url:String(destination_url)});const d=r.data||{};res.json({success:true,pin:{id:d.id,title:d.title,link:d.link,board_id:d.board_id,created_at:d.created_at}});}catch(err){res.status(502).json({error:err?.message||"Pinterest rejected Pin request."});}});
app.get("/api/pinterest/pins/:pinId/product-tags",async(req,res)=>{
  const id=getAccountId(req);if(!id)return res.status(401).json({error:"Not connected to Pinterest."});
  try{const r=await pinterestOp(id,"product_tags",{pin_id:String(req.params.pinId)});res.json({pin_id:String(req.params.pinId),product_tags:r.data?.product_tags||[],read_only:true});}
  catch(err){res.status(err?.status||502).json({error:err?.message||"Could not read Pinterest product tags."});}
});
app.post("/api/pinterest/pins/:pinId/product-tags",async(req,res)=>{
  const id=getAccountId(req);if(!id)return res.status(401).json({error:"Not connected to Pinterest."});
  const productPinIds=req.body?.product_pin_ids;
  if(!Array.isArray(productPinIds)||productPinIds.length<1||productPinIds.length>24||productPinIds.some(x=>typeof x!=="string"||!x.trim())||new Set(productPinIds).size!==productPinIds.length)return res.status(400).json({error:"Provide 1–24 unique, nonblank existing Pinterest product Pin IDs."});
  try{
    const pinId=String(req.params.pinId);
    const before=await pinterestOp(id,"product_tags",{pin_id:pinId});
    const existing=new Set((before.data?.product_tags||[]).map(x=>String(x.pin_id)));
    const missing=productPinIds.map(x=>x.trim()).filter(x=>!existing.has(x));
    if(missing.length)await pinterestOp(id,"add_product_tags",{pin_id:pinId,product_pin_ids:missing});
    const after=await pinterestOp(id,"product_tags",{pin_id:pinId});
    const verified=new Set((after.data?.product_tags||[]).map(x=>String(x.pin_id)));
    const notVerified=productPinIds.map(x=>x.trim()).filter(x=>!verified.has(x));
    if(notVerified.length)return res.status(502).json({error:"Tag write may have completed, but read-back did not confirm all tags. Inspect current tags before retrying.",missing_product_pin_ids:notVerified});
    return res.json({success:true,pin_id:pinId,newly_attached:missing,already_attached:productPinIds.map(x=>x.trim()).filter(x=>existing.has(x)),verified_product_pin_ids:productPinIds.map(x=>x.trim())});
  }catch(err){return res.status(err?.status||502).json({error:err?.message||"Pinterest product tagging failed. Read current tags before retrying."});}
});
app.post("/api/pinterest/boards",async(req,res)=>{const id=getAccountId(req);if(!id)return res.status(401).json({error:"Not connected to Pinterest."});const {name,description}=req.body;if(!name)return res.status(400).json({error:"Board name is required."});try{const r=await pinterestOp(id,"create_board",{name:String(name),description:String(description||"")});const d=r.data||{};res.json({success:true,board:{id:d.id,name:d.name,description:d.description}});}catch(err){res.status(502).json({error:err?.message||"Pinterest rejected board request."});}});
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
