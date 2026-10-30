/**
 * PB-04 regression: a fresh Hub OAuth callback must persist credentials through
 * the authenticated Pinterest Agent boundary before telling the frontend it is connected.
 * All upstream requests are mocked; this test never uses real Pinterest or publishes a Pin.
 */
import assert from "node:assert/strict";

process.env.PINTEREST_CLIENT_ID = "test-client-id";
process.env.PINTEREST_CLIENT_SECRET = "test-client-secret";
process.env.PINTEREST_REDIRECT_URI = "https://modernlivinghub.vercel.app/auth/pinterest/callback";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters-long";
process.env.FRONTEND_URL = "https://modernlivinghub.vercel.app";
process.env.NODE_ENV = "test";
process.env.PORT = "3518";
process.env.PINTEREST_AGENT_API_URL = "https://agent.mock.invalid";
process.env.PINTEREST_AGENT_INGEST_KEY = "test-service-ingest-key";
process.env.PINTEREST_AGENT_READY_TIMEOUT_MS = "100";
process.env.PINTEREST_AGENT_READY_RETRY_MS = "1";

const localBase = `http://127.0.0.1:${process.env.PORT}`;
const agentBase = process.env.PINTEREST_AGENT_API_URL;
const realFetch = globalThis.fetch;
const observed = { credentialRequests: [], operations: [], refreshRequests: [], storeAllowed: true, agentHealthy: true, tokenExchanges: 0, rejectFirstOperation: false };
const fakeTokens = {
  access_token: "mock_access_token_never_returned",
  refresh_token: "mock_refresh_token_never_returned",
  token_type: "bearer",
  scope: "boards:read,boards:write,pins:read,pins:write,user_accounts:read",
  expires_in: 1800,
  refresh_token_expires_in: 2592000,
};

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith(localBase)) return realFetch(input, init);
  if (url === "https://api.pinterest.com/v5/oauth/token") {
    observed.tokenExchanges += 1;
    return new Response(JSON.stringify(fakeTokens), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url === "https://api.pinterest.com/v5/user_account") {
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${fakeTokens.access_token}`);
    return new Response(JSON.stringify({ id: "123456789", username: "mlh_test_user" }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url === `${agentBase}/health`) {
    return new Response(JSON.stringify({ status: observed.agentHealthy ? "ok" : "unavailable", service: "pinterest-affiliate-model-1" }), { status: observed.agentHealthy ? 200 : 502, headers: { "content-type": "application/json" } });
  }
  if (url === `${agentBase}/integrations/pinterest/credentials`) {
    assert.equal(new Headers(init.headers).get("x-credential-ingest-key"), process.env.PINTEREST_AGENT_INGEST_KEY);
    const body = JSON.parse(init.body);
    observed.credentialRequests.push(body);
    return new Response(JSON.stringify(observed.storeAllowed ? { stored: true, account_id: body.account_id } : { stored: false }), { status: 201, headers: { "content-type": "application/json" } });
  }
  if (url === `${agentBase}/integrations/pinterest/refresh`) {
    assert.equal(new Headers(init.headers).get("x-credential-ingest-key"), process.env.PINTEREST_AGENT_INGEST_KEY);
    const body = JSON.parse(init.body);
    observed.refreshRequests.push(body);
    return new Response(JSON.stringify({ refreshed: true, account_id: body.account_id }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url === `${agentBase}/integrations/pinterest/operation`) {
    assert.equal(new Headers(init.headers).get("x-credential-ingest-key"), process.env.PINTEREST_AGENT_INGEST_KEY);
    const body = JSON.parse(init.body);
    observed.operations.push(body);
    if (observed.rejectFirstOperation) {
      observed.rejectFirstOperation = false;
      return new Response(JSON.stringify({ detail: "Pinterest API rejected or could not complete the operation." }), { status: 401, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: { id: "123456789", username: "mlh_test_user" } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`Unexpected upstream request in test: ${url}`);
};

function cookieHeader(response) {
  const items = response.headers.getSetCookie?.() || [];
  return items.map((value) => value.split(";", 1)[0]).join("; ");
}

async function waitForLocalServer() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await realFetch(`${localBase}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Hub test server failed to start");
}

async function startOAuth() {
  const start = await realFetch(`${localBase}/auth/pinterest`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const authUrl = new URL(start.headers.get("location"));
  assert.equal(authUrl.origin, "https://www.pinterest.com");
  assert.equal(authUrl.searchParams.get("client_id"), process.env.PINTEREST_CLIENT_ID);
  const state = authUrl.searchParams.get("state");
  assert.ok(state);
  const cookies = cookieHeader(start);
  assert.ok(cookies.includes("mlh.sid="));
  return { state, cookies };
}

async function callback(flow) {
  return realFetch(`${localBase}/auth/pinterest/callback?code=test-oauth-code&state=${encodeURIComponent(flow.state)}`, {
    redirect: "manual",
    headers: { Cookie: flow.cookies },
  });
}

let exitCode = 0;
try {
  await import("./src/server.js");
  await waitForLocalServer();

  // Agent outage must be detected before exchanging Pinterest's single-use code.
  observed.agentHealthy = false;
  const blockedFlow = await startOAuth();
  const blockedCallback = await callback(blockedFlow);
  assert.equal(blockedCallback.status, 302);
  const blockedUrl = new URL(blockedCallback.headers.get("location"));
  assert.ok(blockedUrl.searchParams.has("pinterest_error"));
  assert.equal(observed.tokenExchanges, 0, "must not consume the authorization code while Agent is unhealthy");
  assert.equal(observed.credentialRequests.length, 0);
  observed.agentHealthy = true;

  // Successful OAuth -> Agent credential ingestion -> one-time handoff -> account check.
  const flow = await startOAuth();
  const callbackResponse = await callback(flow);
  assert.equal(callbackResponse.status, 302);
  const callbackUrl = new URL(callbackResponse.headers.get("location"));
  assert.equal(callbackUrl.searchParams.get("pinterest_connected"), "1");
  const handoff = callbackUrl.searchParams.get("handoff");
  assert.ok(handoff && /^[a-f0-9]{64}$/.test(handoff));
  assert.ok(!callbackUrl.href.includes(fakeTokens.access_token));
  assert.ok(!callbackUrl.href.includes(fakeTokens.refresh_token));
  assert.equal(observed.credentialRequests.length, 1);

  const credential = observed.credentialRequests[0];
  assert.equal(credential.account_id, "pinterest:123456789");
  assert.equal(credential.pinterest_user_id, "123456789");
  assert.equal(credential.username, "mlh_test_user");
  assert.equal(credential.access_token, fakeTokens.access_token);
  assert.equal(credential.refresh_token, fakeTokens.refresh_token);
  assert.equal(credential.scope, fakeTokens.scope);
  assert.ok(Date.parse(credential.expires_at) > Date.now());
  assert.ok(Date.parse(credential.refresh_token_expires_at) > Date.now());

  // A real Agent/Pinterest 401 must trigger exactly one server-side refresh,
  // then retry the original read-only account lookup once.
  observed.rejectFirstOperation = true;
  const complete = await realFetch(`${localBase}/api/pinterest/complete`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handoff }),
  });
  assert.equal(complete.status, 200);
  const completeBody = await complete.json();
  assert.equal(completeBody.connected, true);
  assert.ok(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(completeBody.session_token));
  assert.ok(!JSON.stringify(completeBody).includes(fakeTokens.access_token));
  assert.ok(!JSON.stringify(completeBody).includes(fakeTokens.refresh_token));

  const status = await realFetch(`${localBase}/api/pinterest/status`, {
    headers: { Authorization: `Bearer ${completeBody.session_token}` },
  });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { connected: true, id: "123456789", username: "mlh_test_user" });
  assert.equal(observed.operations.length, 3);
  assert.ok(observed.operations.every((entry) => entry.account_id === "pinterest:123456789" && entry.operation === "account"));
  assert.equal(observed.refreshRequests.length, 1, "401 must cause exactly one refresh attempt");
  assert.deepEqual(observed.refreshRequests[0], {
    account_id: "pinterest:123456789",
    client_id: process.env.PINTEREST_CLIENT_ID,
    client_secret: process.env.PINTEREST_CLIENT_SECRET,
  });
  assert.ok(!JSON.stringify(completeBody).includes(process.env.PINTEREST_CLIENT_SECRET));

  // Signed sessions must not depend on per-process memory and must reject tampering.
  const tamperedToken = completeBody.session_token.replace(/.$/, completeBody.session_token.endsWith("a") ? "b" : "a");
  const tamperedStatus = await realFetch(`${localBase}/api/pinterest/status`, {
    headers: { Authorization: `Bearer ${tamperedToken}` },
  });
  assert.deepEqual(await tamperedStatus.json(), { connected: false });

  // Fail closed: if Agent does not confirm encrypted storage, Hub must not claim success.
  observed.storeAllowed = false;
  const failedFlow = await startOAuth();
  const failedCallback = await callback(failedFlow);
  assert.equal(failedCallback.status, 302);
  const failedUrl = new URL(failedCallback.headers.get("location"));
  assert.ok(failedUrl.searchParams.has("pinterest_error"));
  assert.notEqual(failedUrl.searchParams.get("pinterest_connected"), "1");
  assert.equal(observed.credentialRequests.length, 2);

  console.log("PB-05/PB-04 PASS: authenticated Agent ingestion, OAuth handoff, 401-triggered one-time refresh, retry, expiry persistence, and fail-closed storage verified (mocked upstreams only).");
} catch (error) {
  exitCode = 1;
  console.error("PB-04 FAIL:", error?.stack || String(error));
} finally {
  globalThis.fetch = realFetch;
  // server.js currently owns its listener internally; terminate this standalone test process.
  process.exit(exitCode);
}
