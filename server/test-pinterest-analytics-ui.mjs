/**
 * Static Model 1 analytics/trends regression contracts. No provider calls or Pinterest writes.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ui = await readFile(new URL("../assets/js/pinterest.js", import.meta.url), "utf8");
const html = await readFile(new URL("../pinterest.html", import.meta.url), "utf8");
const server = await readFile(new URL("./src/server.js", import.meta.url), "utf8");
assert.match(ui, /async function loadEngagementAnalytics\(\)/);
assert.match(ui, /if\s*\(data\.ok\s*===\s*false\)/, "HTTP 200 with ok:false must not display as success");
assert.match(ui, /Partial analytics result:/, "partial analytics must be clearly labelled");
assert.match(ui, /Retry later for failed Pins/, "failed Pins must be retryable");
assert.match(ui, /async function loadPinterestTrends\(\)/);
assert.match(ui, /async function loadFeaturedTopics\(\)/);
assert.match(ui, /url\.protocol !== 'https:'/);
assert.match(ui, /url\.hostname !== 'i\.pinimg\.com' && !url\.hostname\.endsWith\('\.i\.pinimg\.com'\)/);
for (const id of ['pinterest-analytics-section','load-engagement-analytics-btn','pinterest-trend-intelligence-section','pinterest-featured-topics-section']) assert.ok(html.includes('id="'+id+'"'), 'missing UI section '+id);
assert.match(server, /app\.post\("\/api\/pinterest\/analytics\/run"/);
assert.match(server, /app\.post\("\/api\/pinterest\/trend-intelligence\/run"/);
assert.match(server, /app\.post\("\/api\/pinterest\/trend-visuals\/run"/);
assert.doesNotMatch(server, /\/api\/pinterest\/ad-accounts|\/api\/pinterest\/audience-insights|\/api\/pinterest\/pins\/:pinId\/product-tags/);
assert.doesNotMatch(html, /product-tags-form|Tag products on an existing Pin|audience-insights-results/);
console.log('Pinterest Model 1 analytics/trends UI PASS (static contract; no provider calls, Pins, or Boards).');
