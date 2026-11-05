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
process.env.PINTEREST_AGENT_READY_TIMEOUT_MS = "1200";
process.env.PINTEREST_AGENT_READY_RETRY_MS = "1";

const localBase = `http://127.0.0.1:${process.env.PORT}`;
const agentBase = process.env.PINTEREST_AGENT_API_URL;
const realFetch = globalThis.fetch;
const realAbortSignalTimeout = AbortSignal.timeout.bind(AbortSignal);
const observedTimeouts = [];
AbortSignal.timeout = (milliseconds) => {
  observedTimeouts.push(milliseconds);
  return realAbortSignalTimeout(milliseconds);
};
const observed = { credentialRequests: [], operations: [], refreshRequests: [], proxyRequests: [], manualPublishRequests: [], proxyStatus: 200, healthStatuses: [], healthRequests: 0, storeAllowed: true, agentHealthy: true, tokenExchanges: 0, rejectFirstOperation: false, refreshStatus: 200 };
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
  if (url === `${agentBase}/integrations/pinterest/publish-manual`) {
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-credential-ingest-key"), process.env.PINTEREST_AGENT_INGEST_KEY);
    assert.match(headers.get("idempotency-key") || "", /^[A-Za-z0-9._:-]{8,200}$/);
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    observed.manualPublishRequests.push({ headers: Object.fromEntries(headers.entries()), body });
    return new Response(JSON.stringify({ published: true, already_published: false, pin_id: "mock-pin-789", board_id: body.board_id, product_id: 77, content_version_id: 88 }), { status: 200, headers: { "content-type": "application/json" } });
  }
  const proxyPaths = [
    "/integrations/pinterest/analytics/run",
    "/integrations/pinterest/ad-accounts",
    "/trend-intelligence/run",
    "/trend-visuals/run",
    "/integrations/pinterest/audience-insights/run",
  ];
  const proxyPath = proxyPaths.find((path) => url === `${agentBase}${path}`);
  if (proxyPath) {
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-credential-ingest-key"), process.env.PINTEREST_AGENT_INGEST_KEY);
    assert.equal(headers.get("content-type"), "application/json");
    const body = JSON.parse(init.body);
    observed.proxyRequests.push({ path: proxyPath, body });
    const status = observed.proxyStatus;
    return new Response(JSON.stringify(status === 200 ? { ok: true, path: proxyPath, data: { sample: "mock-read-only-result" } } : { detail: "mock upstream failure" }), {
      status, headers: { "content-type": "application/json" },
    });
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
  const requestedScopes = authUrl.searchParams.get("scope").split(",");
  assert.deepEqual(requestedScopes, ["boards:read", "boards:write", "pins:read", "pins:write", "user_accounts:read"], "Model 1 requests only organic Pinterest scopes");
  assert.ok(!requestedScopes.includes("ads:read"), "Model 1 defers advertiser access to Model 2");
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
  assert.equal(observed.healthRequests - healthRequestsBefore429, 2, "HTTP 429 must be retried once; OAuth readiness must be checked only once");
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

  // Never claim requested scopes were granted if Pinterest omits the scope field.
  const grantedScope = fakeTokens.scope;
  delete fakeTokens.scope;
  const noScopeFlow = await startOAuth();
  const noScopeCallback = await callback(noScopeFlow);
  assert.equal(noScopeCallback.status, 302);
  assert.equal(observed.credentialRequests[1].scope, "", "missing provider scope must be stored as unknown/empty, not as requested scopes");
  fakeTokens.scope = grantedScope;

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

  // Analytics/trend proxy contracts: authenticated session required, strict input
  // validation, server-to-server key isolation, and upstream status propagation.
  const authHeader = { Authorization: `Bearer ${completeBody.session_token}` };
  const publishPreflight = await realFetch(`${localBase}/api/pinterest/pins`, {
    method: "OPTIONS",
    headers: {
      Origin: process.env.FRONTEND_URL,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,authorization,idempotency-key",
    },
  });
  assert.equal(publishPreflight.status, 204, "cross-origin manual Pin preflight must succeed");
  assert.match(publishPreflight.headers.get("access-control-allow-headers") || "", /\bIdempotency-Key\b/i,
    "CORS must explicitly allow the required manual publication idempotency header");
  const unauthManualPublish = await realFetch(`${localBase}/api/pinterest/pins`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "manual-hub-test-0001" },
    body: JSON.stringify({ board_id: "board-123", title: "Test Pin", image_url: "https://cdn.example.test/pin.png", destination_url: "https://example.test/item" }),
  });
  assert.equal(unauthManualPublish.status, 401, "manual Pin route must require a connected Pinterest session");
  const manualPayload = { board_id: "board-123", title: "Test Pin", description: "Mock-only", image_url: "https://cdn.example.test/pin.png", destination_url: "https://example.test/item" };
  const manualPublish = await realFetch(`${localBase}/api/pinterest/pins`, {
    method: "POST", headers: { ...authHeader, "Content-Type": "application/json", "Idempotency-Key": "manual-hub-test-0002" },
    body: JSON.stringify(manualPayload),
  });
  assert.equal(manualPublish.status, 200, "Hub must forward manual Pin requests to the controlled Agent gateway");
  const manualResult = await manualPublish.json();
  assert.deepEqual(manualResult, { success: true, pin: { id: "mock-pin-789", title: manualPayload.title, link: manualPayload.destination_url, board_id: manualPayload.board_id, already_published: false } });
  assert.equal(observed.manualPublishRequests.length, 1);
  assert.equal(observed.manualPublishRequests[0].body.account_id, "pinterest:123456789");
  assert.deepEqual(Object.fromEntries(Object.entries(observed.manualPublishRequests[0].body).filter(([key]) => key !== "account_id")), manualPayload);
  assert.equal(observed.manualPublishRequests[0].headers["idempotency-key"], "manual-hub-test-0002");
  assert.ok(observedTimeouts.includes(180000), "manual publication must have a longer Agent timeout than the former 15 seconds");
  const proxyCases = [
    { path: "/api/pinterest/analytics/run", method: "POST", body: { period_days: 30 }, expectedAgent: "/integrations/pinterest/analytics/run" },
    { path: "/api/pinterest/ad-accounts", method: "GET", expectedAgent: "/integrations/pinterest/ad-accounts" },
    { path: "/api/pinterest/trend-intelligence/run", method: "POST", body: { regions: ["US"] }, expectedAgent: "/trend-intelligence/run" },
    { path: "/api/pinterest/trend-visuals/run", method: "POST", body: { regions: ["GB+IE"] }, expectedAgent: "/trend-visuals/run" },
    { path: "/api/pinterest/audience-insights", method: "POST", body: { ad_account_id: "123456789" }, expectedAgent: "/integrations/pinterest/audience-insights/run" },
  ];
  for (const testCase of proxyCases) {
    const unauth = await realFetch(`${localBase}${testCase.path}`, {
      method: testCase.method, headers: testCase.body ? { "Content-Type": "application/json" } : {},
      ...(testCase.body ? { body: JSON.stringify(testCase.body) } : {}),
    });
    assert.equal(unauth.status, 401, `${testCase.path} must require a Hub session`);
  }
  const invalidInputs = [
    ["/api/pinterest/analytics/run", { period_days: 0 }],
    ["/api/pinterest/trend-intelligence/run", { regions: ["US", "US"] }],
    ["/api/pinterest/trend-visuals/run", { regions: ["CA"] }],
    ["/api/pinterest/audience-insights", { ad_account_id: "not-an-id" }],
  ];
  for (const [path, body] of invalidInputs) {
    const invalid = await realFetch(`${localBase}${path}`, {
      method: "POST", headers: { ...authHeader, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(invalid.status, 400, `${path} must reject invalid input`);
  }
  for (const testCase of proxyCases) {
    const before = observed.proxyRequests.length;
    const response = await realFetch(`${localBase}${testCase.path}`, {
      method: testCase.method, headers: { ...authHeader, ...(testCase.body ? { "Content-Type": "application/json" } : {}) },
      ...(testCase.body ? { body: JSON.stringify(testCase.body) } : {}),
    });
    assert.equal(response.status, 200, `${testCase.path} mocked success`);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(observed.proxyRequests.length, before + 1);
    const forwarded = observed.proxyRequests.at(-1);
    assert.equal(forwarded.path, testCase.expectedAgent);
    assert.equal(forwarded.body.account_id, "pinterest:123456789");
  }
  for (const upstreamStatus of [401, 502]) {
    observed.proxyStatus = upstreamStatus;
    const failed = await realFetch(`${localBase}/api/pinterest/analytics/run`, {
      method: "POST", headers: { ...authHeader, "Content-Type": "application/json" }, body: JSON.stringify({ period_days: 7 }),
    });
    assert.equal(failed.status, upstreamStatus, `upstream HTTP ${upstreamStatus} must propagate`);
  }
  observed.proxyStatus = 200;
  assert.ok(observedTimeouts.includes(240000), "organic analytics proxy must use its extended Agent timeout");
  assert.ok(observedTimeouts.includes(60000), "read-only trend/ad-account proxies must use their explicit timeout budget");
  assert.ok(observedTimeouts.includes(90000), "audience insights proxy must use its explicit timeout budget");
  assert.ok(observed.proxyRequests.every((entry) => entry.body.account_id === "pinterest:123456789"));

  assert.equal(observed.operations.length, 3);
  assert.ok(observed.operations.every((entry) => entry.account_id === "pinterest:123456789" && entry.operation === "account"));
  assert.equal(observed.refreshRequests.length, 1, "401 must cause exactly one refresh attempt");
  assert.deepEqual(observed.refreshRequests[0], {
    account_id: "pinterest:123456789",
    client_id: process.env.PINTEREST_CLIENT_ID,
    client_secret: process.env.PINTEREST_CLIENT_SECRET,
  });
  assert.ok(!JSON.stringify(completeBody).includes(process.env.PINTEREST_CLIENT_SECRET));

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
  assert.equal(observed.credentialRequests.length, 3);

  console.log("PB-05/PB-04 PASS: authenticated Agent ingestion, OAuth handoff, one-time 401 refresh, no replay after ambiguous refresh 5xx, retry, expiry persistence, and fail-closed storage verified (mocked upstreams only).");
} catch (error) {
  exitCode = 1;
  console.error("PB-04 FAIL:", error?.stack || String(error));
} finally {
  globalThis.fetch = realFetch;
  // server.js currently owns its listener internally; terminate this standalone test process.
  process.exit(exitCode);
}
