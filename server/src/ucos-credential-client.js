/**
 * UCOS credential/operation gateway client.
 * Raw Pinterest OAuth tokens are sent only server-to-server to UCOS and are
 * never returned by this module to browser callers.
 */
const BASE = (process.env.UCOS_API_BASE_URL || "https://ucos-backend.onrender.com").replace(/\/+$/, "");
const TOKEN = String(process.env.UCOS_API_TOKEN || "").trim();

function requireConfig() {
  if (!TOKEN) throw new Error("UCOS_API_TOKEN is not configured");
}

async function request(path, options = {}, retryTransient = false) {
  requireConfig();
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${TOKEN}`,
    ...(options.headers || {}),
  };

  // Render Free can return transient 502/503/504 while the UCOS instance wakes.
  // Retry only explicitly opted-in idempotent reads, with a bounded total wait.
  // Never automatically replay account creation or credential writes.
  const retryDelaysMs = [1000, 2000, 4000, 6000];
  const attempts = retryTransient ? retryDelaysMs.length + 1 : 1;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${BASE}${path}`, {
        ...options,
        headers,
        ...(retryTransient ? { signal: AbortSignal.timeout(5000) } : {}),
      });
      const raw = await response.text();
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      if (response.ok) return body;

      const error = new Error(String(body.error || body.message || `UCOS HTTP ${response.status}`));
      if (![502, 503, 504].includes(response.status) || attempt === attempts) throw error;
      lastError = error;
    } catch (error) {
      const message = String(error?.message || error);
      const transient = /fetch failed|network|ECONNRESET|ETIMEDOUT|timeout|aborted|AbortError|TimeoutError|UCOS HTTP 502|UCOS HTTP 503|UCOS HTTP 504/i.test(message);
      if (attempt === attempts || !retryTransient || !transient) throw error;
      lastError = error;
    }

    if (attempt < attempts) {
      await new Promise(resolve => setTimeout(resolve, retryDelaysMs[attempt - 1]));
    }
  }
  throw lastError || new Error("UCOS request failed");
}

let warmupPromise = null;

export function warmUcosService() {
  // Start warming from the OAuth-start route, in the background only.
  if (warmupPromise) return warmupPromise;
  warmupPromise = (async () => {
    // Keep this preflight bounded so the OAuth-start HTTP request does not hang indefinitely.
    const delays = [0, 2000, 4000, 6000, 8000];
    let lastError;
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt]) await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      try {
        const response = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(4000) });
        if (response.ok) {
          console.info("[pinterest] UCOS health preflight passed", { attempt: attempt + 1, status: response.status });
          return true;
        }
        lastError = new Error(`UCOS health preflight HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
    }
    console.warn("[pinterest] UCOS health preflight did not pass", {
      error: String(lastError?.message || lastError || "unknown"),
    });
    return false;
  })().finally(() => { warmupPromise = null; });
  return warmupPromise;
}

export async function listPinterestAccounts() {
  // Do NOT await the long health warm-up here. The OAuth callback is behind a
  // public reverse proxy; do not wait on the full pre-warm loop inside the
  // callback. The read itself has bounded retries for transient Render 502s.
  const result = await request("/accounts?platform=pinterest", {}, true);
  return Array.isArray(result?.data?.accounts) ? result.data.accounts : [];
}

export async function registerPinterestAccount(user) {
  const userId = String(user?.id || "").trim();
  if (!userId) throw new Error("Pinterest user ID is required to register the account");
  const username = String(user?.username || "").trim();
  const accountId = `pinterest:${userId}`;
  const credentialRef = `pinterest:${userId}`;
  return request("/accounts", {
    method: "POST",
    body: JSON.stringify({
      account_id: accountId,
      platform: "pinterest",
      niche: "beauty",
      display_name: username ? `Pinterest @${username}` : "Pinterest account",
      credentials_ref: credentialRef,
      capabilities: ["boards:read", "boards:write", "pins:read", "pins:write", "user_accounts:read"],
      enabled: true,
      tenant_id: "tenant:modern-living-hub",
      workspace_id: "workspace:modern-living-hub:production",
      brand_id: `brand:modern-living-hub:pinterest:${userId}`,
      platform_account_id: userId,
      external_account_id: userId,
      tenant_name: "Modern Living Hub",
      workspace_name: "Production",
      brand_name: username ? `Pinterest ${username}` : "Pinterest Brand",
      platform_account_name: username ? `Pinterest @${username}` : "Pinterest account",
    }),
  });
}

export async function storePinterestCredential(data) {
  return request("/credentials/pinterest", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function pinterestOperation(accountId, operation, payload = {}) {
  return request("/pinterest/operations", {
    method: "POST",
    body: JSON.stringify({ account_id: accountId, operation, payload }),
  });
}

export async function revokePinterestCredential(accountId, credentialRef) {
  return request("/credentials/pinterest/revoke", {
    method: "POST",
    body: JSON.stringify({ account_id: accountId, credential_ref: credentialRef }),
  });
}
