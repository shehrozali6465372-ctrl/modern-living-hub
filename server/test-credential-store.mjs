process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "credential-store-test-secret";
process.env.PINTEREST_TOKEN_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  initCredentialStore,
  savePinterestCredential,
  getPinterestCredential,
  listPinterestCredentials,
  revokePinterestCredential,
  _testEncrypt
} from "./src/credential-store.js";

await initCredentialStore();

describe("Persistent Pinterest credential security", () => {
  it("encrypts access and refresh tokens and round-trips them", async () => {
    const id = crypto.randomUUID();
    await savePinterestCredential({
      credential_id: id,
      owner_session_id: "owner-1",
      access_token: "ACCESS_SECRET_123",
      refresh_token: "REFRESH_SECRET_456",
      scope: "boards:read pins:write",
      connected_at: new Date().toISOString()
    });

    const encrypted = _testEncrypt("ACCESS_SECRET_123");
    assert.ok(encrypted.startsWith("v1."));
    assert.notEqual(encrypted, "ACCESS_SECRET_123");
    assert.ok(!encrypted.includes("ACCESS_SECRET_123"));

    const record = await getPinterestCredential(id, "owner-1");
    assert.equal(record.access_token, "ACCESS_SECRET_123");
    assert.equal(record.refresh_token, "REFRESH_SECRET_456");

    const unauthorized = await getPinterestCredential(id, "other-owner");
    assert.equal(unauthorized, null);
  });

  it("keeps multiple Pinterest accounts isolated for one owner", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();

    await savePinterestCredential({
      credential_id: a, owner_session_id: "owner-multi",
      access_token: "TOKEN_A", refresh_token: "REFRESH_A",
      scope: "pins:write", connected_at: new Date().toISOString()
    });
    await savePinterestCredential({
      credential_id: b, owner_session_id: "owner-multi",
      access_token: "TOKEN_B", refresh_token: "REFRESH_B",
      scope: "pins:write", connected_at: new Date().toISOString()
    });

    const accounts = await listPinterestCredentials("owner-multi");
    assert.equal(accounts.length, 2);
    assert.notEqual(accounts[0].credential_id, accounts[1].credential_id);
    assert.ok(!JSON.stringify(accounts).includes("TOKEN_A"));
    assert.ok(!JSON.stringify(accounts).includes("TOKEN_B"));
  });

  it("revocation removes usable secrets", async () => {
    const id = crypto.randomUUID();
    await savePinterestCredential({
      credential_id: id, owner_session_id: "owner-revoke",
      access_token: "TOKEN_REVOKE", refresh_token: "REFRESH_REVOKE",
      scope: "pins:write", connected_at: new Date().toISOString()
    });

    assert.equal(await revokePinterestCredential(id, "owner-revoke"), true);
    assert.equal(await getPinterestCredential(id, "owner-revoke"), null);
  });
});

console.log("\nCredential-store security tests complete.\n");
