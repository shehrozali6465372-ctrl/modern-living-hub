/**
 * UCOS credential/operation gateway client.
 * Raw Pinterest OAuth tokens are sent only server-to-server to UCOS and are
 * never returned by this module to browser callers.
 */
const BASE = (process.env.UCOS_API_BASE_URL || "https://ucos-backend.onrender.com").replace(/\\/+$/, "");
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

  // Render Free services can take about a minute to wake from idle. Five
  // attempts with a 15-second total backoff ended before that window elapsed.
  // Retry only safe reads; never automatically replay credential writes.
  const retryDelaysMs = [2000, 4000, 8000, 12000, 15000, 15000, 15000];
  const attempts = retryTransient ? retryDelaysMs.length + 1 : 1;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${BASE}${path}`, {
        ...options,
        headers,
        ...(retryTransient ? { signal: AbortSignal.timeout(15000) } : {}),
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

export async function listPinterestAccounts() {
  // Retry only this idempotent read to cover Render cold-start and transient gateway failures.
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
