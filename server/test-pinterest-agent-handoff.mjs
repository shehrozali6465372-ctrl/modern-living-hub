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
process.env.PINTEREST_AGENT_APP_API_KEY = "test-scheduler-app-key";
process.env.PINTEREST_AGENT_READY_TIMEOUT_MS = "1200";
process.env.PINTEREST_AGENT_READY_RETRY_MS = "1";

const localBase = `http://127.0.0.1:${process.env.PORT}`;
const agentBase = process.env.PINTEREST_AGENT_API_URL;
const realFetch = globalThis.fetch;
const observed = { credentialRequests: [], operations: [], refreshRequests: [], publishRequests: [], healthStatuses: [], healthRequests: 0, storeAllowed: true, agentHealthy: true, tokenExchanges: 0, rejectFirstOperation: false, refreshStatus: 200, schedulerRequests: [] };
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
    observed.healthRequests += 1;
    const queuedStatus = observed.healthStatuses.shift();
    const status = queuedStatus ?? (observed.agentHealthy ? 200 : 502);
    const headers = { "content-type": "application/json" };
    if (status === 429) headers["retry-after"] = "0";
    return new Response(JSON.stringify({ status: status === 200 ? "ok" : "unavailable", service: "pinterest-affiliate-model-1" }), { status, headers });
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
    return new Response(JSON.stringify(observed.refreshStatus === 200 ? { refreshed: true, account_id: body.account_id } : { detail: "sanitized refresh failure" }), { status: observed.refreshStatus, headers: { "content-type": "application/json" } });
  }
  if (url === `${agentBase}/workflow/publish-hub-pin`) {
    assert.equal(new Headers(init.headers).get("x-credential-ingest-key"), process.env.PINTEREST_AGENT_INGEST_KEY);
    const body = JSON.parse(init.body);
    observed.publishRequests.push({ body, headers: new Headers(init.headers) });
    return new Response(JSON.stringify({
      published: true, pin_id: "mock-ledger-pin-id", title: body.title,
      board_id: body.board_id, affiliate_url: body.destination_url,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.startsWith(`${agentBase}/affiliate-scheduler/`)) {
    assert.equal(new Headers(init.headers).get("x-api-key"), process.env.PINTEREST_AGENT_APP_API_KEY);
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    observed.schedulerRequests.push({ url: parsed.pathname, method: init.method || "GET", body });
    if (parsed.pathname === "/affiliate-scheduler/schedules" && init.method === "POST") {
      return new Response(JSON.stringify({ schedule_id: 77, status: "draft", source_count: body.sources.length, jobs_created: 0, publishing_started: false }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (parsed.pathname === "/affiliate-scheduler/schedules/77" && (!init.method || init.method === "GET")) {
      return new Response(JSON.stringify({ schedule_id: 77, account_id: "pinterest:123456789", status: "draft", source_count: 1, daily_pin_limit: 5, starts_on: "2026-11-05", ends_on: "2026-12-04", timezone: "America/New_York", job_counts: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (parsed.pathname === "/affiliate-scheduler/schedules/77/activate" || parsed.pathname === "/affiliate-scheduler/schedules/77/pause") {
      return new Response(JSON.stringify({ schedule_id: 77, status: parsed.pathname.endsWith("activate") ? "active" : "paused", jobs_created: 150 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ detail: "unexpected scheduler test route" }), { status: 404, headers: { "content-type": "application/json" } });
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

  // A 429 must honor Retry-After and retry until the Agent becomes healthy.
  const healthRequestsBefore429 = observed.healthRequests;
  observed.healthStatuses = [429, 200];
  const flow = await startOAuth();
  const callbackResponse = await callback(flow);
  assert.equal(observed.healthRequests - healthRequestsBefore429, 2, "the OAuth callback readiness preflight must retry one 429 then succeed");
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
  const rejectedOrigin = await realFetch(`${localBase}/api/pinterest/complete`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.invalid" }, body: JSON.stringify({ handoff }),
  });
  assert.equal(rejectedOrigin.status, 403, "OAuth handoff completion must reject untrusted origins");

  const complete = await realFetch(`${localBase}/api/pinterest/complete`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: process.env.FRONTEND_URL }, body: JSON.stringify({ handoff }),
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

  // Scheduler Hub proxy uses a separate server-side API key and binds the connected account.
  const draftResponse = await realFetch(`${localBase}/api/pinterest/affiliate-schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${completeBody.session_token}`, Origin: process.env.FRONTEND_URL },
    body: JSON.stringify({
      timezone: "America/New_York", starts_on: "2026-11-05", days: 30, daily_pin_limit: 5,
      board_name: "MLH test board", board_description: "test only",
      account_id: "pinterest:attacker-controlled",
      sources: [{ product_name: "Test product", product_details: "Test description", affiliate_url: "https://example.com/item?tag=tracking-20" }],
    }),
  });
  assert.equal(draftResponse.status, 201);
  const draftBody = await draftResponse.json();
  assert.equal(draftBody.publishing_started, false);
  assert.equal(draftBody.jobs_created, 0);
  const forwardedDraft = observed.schedulerRequests.find((entry) => entry.url === "/affiliate-scheduler/schedules");
  assert.equal(forwardedDraft.body.account_id, "pinterest:123456789", "Hub must override any browser-supplied account ID");
  assert.equal(forwardedDraft.body.sources[0].affiliate_url, "https://example.com/item?tag=tracking-20");
  assert.equal(observed.publishRequests.length, 0, "saving a draft must not publish a Pin");
  assert.equal(observed.schedulerRequests[0].method, "POST");
  const schedulerStatus = await realFetch(`${localBase}/api/pinterest/affiliate-schedules/77`, {
    headers: { Authorization: `Bearer ${completeBody.session_token}` },
  });
  assert.equal(schedulerStatus.status, 200);
  const schedulerActivate = await realFetch(`${localBase}/api/pinterest/affiliate-schedules/77/activate`, {
    method: "POST", headers: { Authorization: `Bearer ${completeBody.session_token}`, "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(schedulerActivate.status, 200);
  const schedulerPause = await realFetch(`${localBase}/api/pinterest/affiliate-schedules/77/pause`, {
    method: "POST", headers: { Authorization: `Bearer ${completeBody.session_token}`, "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(schedulerPause.status, 200);
  assert.equal(observed.schedulerRequests.length, 6, "status ownership must be checked before activate and pause");
  assert.equal(observed.publishRequests.length, 0, "scheduler proxy tests must not call any Pin publication route");

  // Hub Pin writes must use the Agent's canonical idempotent publication gateway.
  const hubPinResponse = await realFetch(`${localBase}/api/pinterest/pins`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${completeBody.session_token}`,
      "Idempotency-Key": "hub-test-pin-0001",
      Origin: process.env.FRONTEND_URL,
    },
    body: JSON.stringify({
      board_id: "board-test-1",
      title: "Test kitchen organizer",
      description: "Useful kitchen organization idea",
      alt_text: "A three-tier spice rack holding labeled spice jars",
      image_url: "https://example.com/test-pin.jpg",
      destination_url: "https://example.com/product?tag=affiliate-20",
    }),
  });
  assert.equal(hubPinResponse.status, 200);
  const hubPinBody = await hubPinResponse.json();
  assert.equal(hubPinBody.pin.id, "mock-ledger-pin-id");
  assert.equal(observed.publishRequests.length, 1);
  assert.equal(observed.publishRequests[0].headers.get("idempotency-key"), "hub-test-pin-0001");
  assert.equal(observed.publishRequests[0].body.alt_text, "A three-tier spice rack holding labeled spice jars");
  assert.equal(observed.publishRequests[0].body.destination_url, "https://example.com/product?tag=affiliate-20");
  assert.equal(observed.operations.some((entry) => entry.operation === "create_pin"), false);

  // A refresh 5xx is an ambiguous, non-idempotent OAuth outcome. The Hub must
  // make exactly one refresh attempt and must not replay the old refresh token.
  observed.rejectFirstOperation = true;
  observed.refreshStatus = 503;
  const refreshCountBeforeFailure = observed.refreshRequests.length;
  const operationCountBeforeFailure = observed.operations.length;
  const failedRefreshStatus = await realFetch(`${localBase}/api/pinterest/status`, {
    headers: { Authorization: `Bearer ${completeBody.session_token}` },
  });
  assert.equal(failedRefreshStatus.status, 200);
  assert.deepEqual(await failedRefreshStatus.json(), { connected: false, needs_reauth: true });
  assert.equal(observed.refreshRequests.length, refreshCountBeforeFailure + 1, "ambiguous OAuth refresh must never be automatically replayed");
  assert.equal(observed.operations.length, operationCountBeforeFailure + 1, "do not retry the protected operation when refresh was not confirmed");
  observed.refreshStatus = 200;

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

  console.log("PB-05/PB-04 PASS: authenticated Agent ingestion, OAuth handoff, one-time 401 refresh, no replay after ambiguous refresh 5xx, retry, expiry persistence, and fail-closed storage verified (mocked upstreams only).");
} catch (error) {
  exitCode = 1;
  console.error("PB-04 FAIL:", error?.stack || String(error));
} finally {
  globalThis.fetch = realFetch;
  // server.js currently owns its listener internally; terminate this standalone test process.
  process.exit(exitCode);
}
