/** Static frontend safety contracts for the Model 2 Agent boundary. No provider calls or writes. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ui = await readFile(new URL("../assets/js/pinterest.js", import.meta.url), "utf8");
const server = await readFile(new URL("./src/server.js", import.meta.url), "utf8");
assert.match(ui, /PENDING_BOARD_OPERATION_KEY/);
assert.match(ui, /window\.crypto\.getRandomValues/);
assert.match(ui, /'Idempotency-Key': pendingBoardOperation\.key/);
assert.match(ui, /data\.replayed/);
assert.match(ui, /Board creation outcome is uncertain\. Do not create another board/);
assert.match(ui, /data\.operation_rejected === true/);
assert.doesNotMatch(ui, /res\.status < 500 && res\.status !== 409/);
assert.match(ui, /same idempotency key has been retained/);
assert.match(ui, /Pinterest-side token revocation was NOT performed/);
assert.match(ui, /data\.refresh_outcome_uncertain/);
assert.match(ui, /data\.agent_unavailable/);
assert.match(server, /A valid Idempotency-Key header is required for board creation/);
assert.match(server, /replayed:r\.replayed===true/);
assert.match(server, /previously rejected/);
assert.match(server, /Pinterest API rejected or could not complete the operation/);
assert.match(server, /provider_token_revoked:result\?\.provider_token_revoked===true/);
assert.match(server, /refresh_outcome_uncertain:true/);
assert.match(server, /status>=500&&status<=599/);
assert.match(server, /no OAuth request was sent/);
assert.match(server, /fetch failed|ECONNRESET/);
assert.match(server, /pinterestRefreshAttempted/);
assert.match(server, /agent_unavailable:true/);
console.log("Pinterest Model 2 Hub contract PASS (stable board key, replay handling, uncertain outcome, refresh and disconnect disclosures).");
