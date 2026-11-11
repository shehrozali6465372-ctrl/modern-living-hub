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
const realAbortSignalTimeout = AbortSignal.timeout.bind(AbortSignal);
const observedTimeouts = [];
AbortSignal.timeout = (milliseconds) => { observedTimeouts.push(milliseconds); return realAbortSignalTimeout(milliseconds); };
const observed = { credentialRequests: [], operations: [], operationHeaders: [], boardReplay: false, boardStatus: 200, boardRejected: false, boardDetail: "Pinterest API rejected or could not complete the operation.", refreshRequests: [], publishRequests: [], healthStatuses: [], healthRequests: 0, storeAllowed: true, agentHealthy: true, tokenExchanges: 0, rejectFirstOperation: false, refreshStatus: 200, refreshDetail: "sanitized refresh failure", refreshNetworkFailure: false, accountStatus: 200, accountDetail: "sanitized account failure", schedulerRequests: [] };
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
    if (observed.refreshNetworkFailure) {
      observed.refreshNetworkFailure = false;
      throw new TypeError("fetch failed");
    }
    return new Response(JSON.stringify(observed.refreshStatus === 200 ? { refreshed: true, account_id: body.account_id } : { detail: observed.refreshStatus === 409 ? "Pinterest refresh outcome is uncertain or still in progress; automatic retry is blocked. Reconnect or verify the account before another refresh." : observed.refreshDetail }), { status: observed.refreshStatus, headers: { "content-type": "application/json" } });
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
    observed.operationHeaders.push(new Headers(init.headers));
    if (observed.rejectFirstOperation) {
      observed.rejectFirstOperation = false;
      return new Response(JSON.stringify({ detail: "Pinterest API rejected or could not complete the operation." }), { status: 401, headers: { "content-type": "application/json" } });
    }
    if (body.operation === "account" && observed.accountStatus !== 200) {
      return new Response(JSON.stringify({ detail: observed.accountDetail }), { status: observed.accountStatus, headers: { "content-type": "application/json" } });
    }
    if (body.operation === "create_board") return new Response(JSON.stringify(observed.boardStatus === 200 ? { data: { id: "mock-board-id", name: body.payload.name, description: body.payload.description }, replayed: observed.boardReplay } : { detail: observed.boardRejected ? "This board operation was previously rejected; use a new reviewed operation after resolving the rejection." : observed.boardDetail }), { status: observed.boardStatus, headers: { "content-type": "application/json" } });
    if (body.operation === "disconnect") return new Response(JSON.stringify({ disconnected: true, local_access_disabled: true, provider_token_revoked: false, message: "Local credential disabled; Pinterest-side token revocation was not performed." }), { status: 200, headers: { "content-type": "application/json" } });
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

  // Browser preflight must permit the Idempotency-Key header required by the canonical gateway.
  const idempotencyPreflight = await realFetch(localBase + "/api/pinterest/pins", {
    method: "OPTIONS",
    headers: { Origin: process.env.FRONTEND_URL, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization,idempotency-key" },
  });
  assert.equal(idempotencyPreflight.status, 204);
  assert.match(idempotencyPreflight.headers.get("access-control-allow-headers") || "", /Idempotency-Key/i);

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

  // Board creation must carry a stable idempotency key through the Hub boundary.
  const missingBoardKey = await realFetch(`${localBase}/api/pinterest/boards`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${completeBody.session_token}` },
    body: JSON.stringify({ name: "Model 2 contract test", description: "No provider call without a key" }),
  });
  assert.equal(missingBoardKey.status, 400);
  const boardKey = "hub-board-operation-0001";
  const boardPayload = { name: "Model 2 contract test", description: "Idempotency contract only" };
  const boardCreated = await realFetch(`${localBase}/api/pinterest/boards`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${completeBody.session_token}`, "Idempotency-Key": boardKey },
    body: JSON.stringify(boardPayload),
  });
  assert.equal(boardCreated.status, 200);
  const boardCreatedBody = await boardCreated.json();
  assert.equal(boardCreatedBody.board.id, "mock-board-id");
  assert.equal(boardCreatedBody.replayed, false);
  assert.equal(observed.operationHeaders.at(-1).get("idempotency-key"), boardKey);
  observed.boardReplay = true;
  const boardReplay = await realFetch(`${localBase}/api/pinterest/boards`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${completeBody.session_token}`, "Idempotency-Key": boardKey },
    body: JSON.stringify(boardPayload),
  });
  assert.equal(boardReplay.status, 200);
  assert.equal((await boardReplay.json()).replayed, true);
  assert.equal(observed.operationHeaders.at(-1).get("idempotency-key"), boardKey);
  observed.boardReplay = false;
  observed.boardStatus = 409;
  observed.boardDetail = "Board creation outcome is uncertain or still in progress; automatic retry is blocked pending reconciliation.";
  const uncertainBoardOpsBefore = observed.operations.length;
  const uncertainBoard = await realFetch(`${localBase}/api/pinterest/boards`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${completeBody.session_token}`, "Idempotency-Key": "hub-board-uncertain-0001" },
    body: JSON.stringify(boardPayload),
  });
  assert.equal(uncertainBoard.status, 409);
  assert.equal((await uncertainBoard.json()).outcome_unknown, true);
  assert.equal(observed.operations.length, uncertainBoardOpsBefore + 1, "uncertain board outcome must not trigger an automatic retry");
  observed.boardStatus = 200;
  observed.boardDetail = "Pinterest API rejected or could not complete the operation.";
  observed.boardStatus = 409;
  observed.boardRejected = true;
  const rejectedBoard = await realFetch(`${localBase}/api/pinterest/boards`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${completeBody.session_token}`, "Idempotency-Key": "hub-board-rejected-0001" },
    body: JSON.stringify(boardPayload),
  });
  assert.equal(rejectedBoard.status, 409);
  const rejectedBoardBody = await rejectedBoard.json();
  assert.equal(rejectedBoardBody.outcome_unknown, false);
  assert.equal(rejectedBoardBody.operation_rejected, true, "definitive rejection must be distinguished from uncertain outcome");
  observed.boardStatus = 200;
  observed.boardRejected = false;
  observed.boardStatus = 400;
  observed.boardDetail = "Pinterest API rejected or could not complete the operation.";
  const definitiveBoardRejection = await realFetch(`${localBase}/api/pinterest/boards`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${completeBody.session_token}`, "Idempotency-Key": "hub-board-provider-rejected-0001" },
    body: JSON.stringify(boardPayload),
  });
  assert.equal(definitiveBoardRejection.status, 400);
  assert.equal((await definitiveBoardRejection.json()).operation_rejected, true, "Agent-confirmed provider rejection must be distinguishable from a Hub-level 4xx");
  observed.boardStatus = 200;
  observed.boardDetail = "Pinterest API rejected or could not complete the operation.";

  // A Hub-level 401 occurs before the Agent sees the request and must not create or clear an Agent idempotency result.
  const operationsBeforeHubUnauthorized = observed.operations.length;
  const hubUnauthorizedBoard = await realFetch(`${localBase}/api/pinterest/boards`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "hub-board-hub-401-0001" },
    body: JSON.stringify(boardPayload),
  });
  assert.equal(hubUnauthorizedBoard.status, 401);
  assert.equal(observed.operations.length, operationsBeforeHubUnauthorized, "Hub-level 401 must not reach the Agent");

  // A preflight 401 may refresh once; the same board idempotency key must survive that retry.
  observed.rejectFirstOperation = true;
  const refreshesBeforeBoardRetry = observed.refreshRequests.length;
  const boardRetry = await realFetch(`${localBase}/api/pinterest/boards`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${completeBody.session_token}`, "Idempotency-Key": "hub-board-refresh-retry-0001" },
    body: JSON.stringify(boardPayload),
  });
  assert.equal(boardRetry.status, 200);
  const retryHeaders = observed.operationHeaders.slice(-2);
  assert.equal(retryHeaders.length, 2);
  assert.equal(retryHeaders[0].get("idempotency-key"), "hub-board-refresh-retry-0001");
  assert.equal(retryHeaders[1].get("idempotency-key"), "hub-board-refresh-retry-0001");
  assert.equal(observed.refreshRequests.length, refreshesBeforeBoardRetry + 1);

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

  // A Model 2 refresh 409 is an ambiguous, non-idempotent OAuth outcome. The Hub must
  // make exactly one refresh attempt and must not replay the old refresh token.
  observed.rejectFirstOperation = true;
  observed.refreshStatus = 409;
  const refreshCountBeforeFailure = observed.refreshRequests.length;
  const operationCountBeforeFailure = observed.operations.length;
  const failedRefreshStatus = await realFetch(`${localBase}/api/pinterest/status`, {
    headers: { Authorization: `Bearer ${completeBody.session_token}` },
  });
  assert.equal(failedRefreshStatus.status, 200);
  assert.deepEqual(await failedRefreshStatus.json(), { connected: false, needs_reauth: true, refresh_outcome_uncertain: true, message: "Pinterest refresh outcome is uncertain. Do not retry refresh; reconnect Pinterest or verify the account first." });
  assert.equal(observed.refreshRequests.length, refreshCountBeforeFailure + 1, "ambiguous OAuth refresh must never be automatically replayed");
  assert.equal(observed.operations.length, operationCountBeforeFailure + 1, "do not retry the protected operation when refresh was not confirmed");
  observed.refreshStatus = 503;
  observed.refreshDetail = "Pinterest OAuth refresh outcome is uncertain; automatic retry is blocked.";
  observed.rejectFirstOperation = true;
  const refreshCountBefore5xx = observed.refreshRequests.length;
  const operationCountBefore5xx = observed.operations.length;
  const failedRefresh5xx = await realFetch(`${localBase}/api/pinterest/status`, {
    headers: { Authorization: `Bearer ${completeBody.session_token}` },
  });
  assert.equal(failedRefresh5xx.status, 200);
  const failedRefresh5xxBody = await failedRefresh5xx.json();
  assert.equal(failedRefresh5xxBody.refresh_outcome_uncertain, true, "5xx after refresh attempt must be surfaced as uncertain");
  assert.equal(observed.refreshRequests.length, refreshCountBefore5xx + 1);
  assert.equal(observed.operations.length, operationCountBefore5xx + 1, "protected operation must not replay after ambiguous 5xx refresh");

  observed.refreshStatus = 503;
  observed.refreshDetail = "Pinterest refresh ledger is unavailable; no OAuth request was sent.";
  observed.rejectFirstOperation = true;
  const definitiveRefreshInfrastructureFailure = await realFetch(`${localBase}/api/pinterest/status`, {
    headers: { Authorization: `Bearer ${completeBody.session_token}` },
  });
  assert.equal(definitiveRefreshInfrastructureFailure.status, 200);
  assert.deepEqual(await definitiveRefreshInfrastructureFailure.json(), { connected: false, agent_unavailable: true, message: "Pinterest Agent is temporarily unavailable. Your authorization has not been confirmed as invalid; do not reconnect yet. Retry after the Agent recovers." }, "pre-provider 503 must be surfaced as Agent unavailable, not an uncertain refresh or invalid authorization");

  observed.refreshStatus = 200;
  observed.rejectFirstOperation = true;
  observed.refreshNetworkFailure = true;
  const refreshCountBeforeNetwork = observed.refreshRequests.length;
  const operationCountBeforeNetwork = observed.operations.length;
  const failedRefreshNetwork = await realFetch(`${localBase}/api/pinterest/status`, {
    headers: { Authorization: `Bearer ${completeBody.session_token}` },
  });
  assert.equal(failedRefreshNetwork.status, 200);
  assert.equal((await failedRefreshNetwork.json()).refresh_outcome_uncertain, true, "transport failure during refresh must be surfaced as uncertain");
  assert.equal(observed.refreshRequests.length, refreshCountBeforeNetwork + 1);
  assert.equal(observed.operations.length, operationCountBeforeNetwork + 1, "protected operation must not replay after ambiguous transport failure");

  observed.refreshStatus = 400;
  observed.refreshDetail = "Pinterest rejected token refresh. Reconnect the account if the refresh token is invalid or expired.";
  observed.rejectFirstOperation = true;
  const definitiveRefreshFailure = await realFetch(`${localBase}/api/pinterest/status`, {
    headers: { Authorization: `Bearer ${completeBody.session_token}` },
  });
  assert.equal(definitiveRefreshFailure.status, 200);
  assert.deepEqual(await definitiveRefreshFailure.json(), { connected: false, needs_reauth: true }, "definitive 4xx must not be mislabeled as uncertain");
  observed.refreshStatus = 200;
  observed.refreshDetail = "sanitized refresh failure";

  // A 5xx from the original account operation is not a refresh failure and must not be mislabeled.
  observed.accountStatus = 502;
  observed.accountDetail = "Stored Pinterest account could not be verified; operation was not sent.";
  const refreshCountBeforeAccountFailure = observed.refreshRequests.length;
  const accountFailure = await realFetch(`${localBase}/api/pinterest/status`, {
    headers: { Authorization: `Bearer ${completeBody.session_token}` },
  });
  assert.equal(accountFailure.status, 200);
  assert.deepEqual(await accountFailure.json(), { connected: false, agent_unavailable: true, message: "Pinterest Agent is temporarily unavailable. Your authorization has not been confirmed as invalid; do not reconnect yet. Retry after the Agent recovers." });
  assert.equal(observed.refreshRequests.length, refreshCountBeforeAccountFailure, "account-operation 5xx must not be treated as an attempted OAuth refresh");
  observed.accountStatus = 200;
  observed.accountDetail = "sanitized account failure";

  // Disconnect is local-only in Model 2; Hub must not imply provider token revocation.
  const disconnectResponse = await realFetch(`${localBase}/api/pinterest/disconnect`, {
    method: "POST", headers: { Authorization: `Bearer ${completeBody.session_token}` },
  });
  assert.equal(disconnectResponse.status, 200);
  const disconnectBody = await disconnectResponse.json();
  assert.equal(disconnectBody.disconnected, true);
  assert.equal(disconnectBody.provider_token_revoked, false);

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

  console.log("PB-05/PB-04 PASS: authenticated Agent ingestion, OAuth handoff, one-time 401 refresh, no replay after ambiguous refresh 409/5xx/transport failures, definitive error classification, retry, expiry persistence, and fail-closed storage verified (mocked upstreams only).");
} catch (error) {
  exitCode = 1;
  console.error("PB-04 FAIL:", error?.stack || String(error));
} finally {
  globalThis.fetch = realFetch;
  // server.js currently owns its listener internally; terminate this standalone test process.
  process.exit(exitCode);
}
