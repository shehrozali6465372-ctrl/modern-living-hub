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
  const attempts = retryTransient ? 3 : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${BASE}${path}`, { ...options, headers });
      const raw = await response.text();
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      if (response.ok) return body;
      const error = new Error(String(body.error || body.message || `UCOS HTTP ${response.status}`));
      if (![502, 503, 504].includes(response.status) || attempt === attempts) throw error;
      lastError = error;
    } catch (error) {
      if (attempt === attempts || !retryTransient || !/fetch failed|network|ECONNRESET|ETIMEDOUT|UCOS HTTP 502|UCOS HTTP 503|UCOS HTTP 504/i.test(String(error?.message || error))) {
        throw error;
      }
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 400 * attempt));
  }
  throw lastError || new Error("UCOS request failed");
}

export async function listPinterestAccounts() {
  // Render can briefly return a gateway 502 while the free service wakes/restarts.
  // Retry this read only; do not automatically replay credential-write POSTs.
  const result = await request("/accounts?platform=pinterest", {}, true);
  return Array.isArray(result?.data?.accounts) ? result.data.accounts : [];
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
