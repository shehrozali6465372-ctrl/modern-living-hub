/**
 * Regression contracts for Pinterest analytics, consent recovery, and trusted image hosts.
 * Static checks only: no provider calls and no Pinterest publishing.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../assets/js/pinterest.js", import.meta.url), "utf8");
const start = source.indexOf("async function loadEngagementAnalytics()");
const end = source.indexOf("\n    function renderAudienceBreakdown", start);
assert.notEqual(start, -1, "analytics handler must exist");
assert.ok(end > start, "analytics handler must have a clear end");
const handler = source.slice(start, end);
const advertiserStart = source.indexOf("async function loadAdvertiserAccounts()");
const advertiserEnd = source.indexOf("\n    async function loadEngagementAnalytics()", advertiserStart);
assert.ok(advertiserEnd > advertiserStart, "advertiser account loader must exist");
const advertiserLoader = source.slice(advertiserStart, advertiserEnd);
const audienceStart = source.indexOf("async function loadAudienceInsights()");
const audienceEnd = source.indexOf("\n    if (loadEngagementBtn)", audienceStart);
assert.ok(audienceEnd > audienceStart, "audience insights loader must exist");
const audienceLoader = source.slice(audienceStart, audienceEnd);
const featuredStart = source.indexOf("function renderFeaturedTopics(payload)");
const featuredEnd = source.indexOf("\n    async function loadFeaturedTopics()", featuredStart);
assert.ok(featuredEnd > featuredStart, "featured topic renderer must exist");
const featuredRenderer = source.slice(featuredStart, featuredEnd);

assert.match(featuredRenderer, /url\.protocol !== 'https:'/);
assert.match(featuredRenderer, /url\.hostname !== 'i\.pinimg\.com' && !url\.hostname\.endsWith\('\.i\.pinimg\.com'\)/, "Pinterest image host validation must reject lookalike suffix domains");
assert.match(advertiserLoader, /data\.requires_scope && reconnectAdsLink/, "missing advertiser scope must offer a reconnect path");
assert.match(advertiserLoader, /auth\/pinterest\?prompt=consent/, "reconnect must request explicit Pinterest consent");
assert.match(audienceLoader, /!res\.ok \|\| data\.ok === false/, "audience API partial/error payload must not display as success");
assert.match(handler, /if\s*\(data\.ok\s*===\s*false\)/, "HTTP 200 with ok:false must be treated as partial failure");
assert.match(handler, /renderMetricList\(engagementResults/, "available aggregate metrics must remain visible on partial failure");
assert.match(handler, /pinResults\.length === pinsChecked[\s\S]*?pinResults\.filter\(function\s*\(pin\)\s*\{\s*return pin && pin\.ok === false;\s*\}\)/, "failed Pins must be counted from complete per-Pin results");
assert.match(handler, /Partial analytics result:/, "UI must explicitly label partial results");
assert.match(handler, /Retry later for failed Pins/, "UI must tell the user failed Pins can be retried");
assert.match(handler, /Math\.max\(0, pinsChecked - snapshotsSaved\)/, "failed count must have a safe fallback");
console.log("Pinterest analytics UI PASS: partial results preserve available metrics and visibly report failed Pins (static regression contract; no provider calls).");
