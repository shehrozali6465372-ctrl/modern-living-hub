/**
 * Persistent Pinterest credential store.
 *
 * Production:
 *   - PostgreSQL is the source of truth.
 *   - access_token and refresh_token are encrypted with AES-256-GCM.
 *   - The encryption key is supplied only through PINTEREST_TOKEN_ENCRYPTION_KEY.
 *
 * Test:
 *   - NODE_ENV=test uses an in-memory adapter so unit/E2E tests need no database.
 *   - Production never falls back to memory storage.
 */
import crypto from "node:crypto";

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS pinterest_credentials (
  credential_id UUID PRIMARY KEY,
  owner_session_id TEXT NOT NULL,
  pinterest_user_id TEXT,
  username TEXT,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  token_type TEXT NOT NULL DEFAULT 'bearer',
  scope TEXT NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pinterest_credentials_owner
  ON pinterest_credentials(owner_session_id);
CREATE INDEX IF NOT EXISTS idx_pinterest_credentials_user
  ON pinterest_credentials(pinterest_user_id);
`;

let pool = null;
let memoryMode = false;
const memory = new Map();

function getKey() {
  const raw = process.env.PINTEREST_TOKEN_ENCRYPTION_KEY;
  if (raw) {
    const key = Buffer.from(raw, "base64");
    if (key.length === 32) return key;
    const hex = Buffer.from(raw, "hex");
    if (hex.length === 32) return hex;
  }
  if (process.env.NODE_ENV === "test") {
    return crypto.createHash("sha256").update(process.env.SESSION_SECRET || "test-only").digest();
  }
  throw new Error("PINTEREST_TOKEN_ENCRYPTION_KEY must be a base64 or hex encoded 32-byte key.");
}

function encryptSecret(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${tag.toString("base64url")}`;
}

function decryptSecret(value) {
  if (!value) return null;
  const [version, iv64, ciphertext64, tag64] = String(value).split(".");
  if (version !== "v1" || !iv64 || !ciphertext64 || !tag64) throw new Error("Invalid encrypted credential.");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(iv64, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tag64, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext64, "base64url")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}

function normalize(row) {
  if (!row) return null;
  return {
    credential_id: row.credential_id,
    owner_session_id: row.owner_session_id,
    pinterest_user_id: row.pinterest_user_id || null,
    username: row.username || null,
    access_token: decryptSecret(row.access_token_enc),
    refresh_token: decryptSecret(row.refresh_token_enc),
    token_type: row.token_type || "bearer",
    scope: row.scope || "",
    connected_at: row.connected_at instanceof Date ? row.connected_at.toISOString() : row.connected_at,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    revoked_at: row.revoked_at ? (row.revoked_at instanceof Date ? row.revoked_at.toISOString() : row.revoked_at) : null
  };
}

export async function initCredentialStore() {
  if (process.env.NODE_ENV === "test") {
    memoryMode = true;
    return { mode: "memory-test" };
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for persistent Pinterest credential storage.");
  }

  const { Pool } = await import("pg");
  pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  await pool.query(TABLE_SQL);
  return { mode: "postgres" };
}

export async function savePinterestCredential(input) {
  const row = {
    credential_id: input.credential_id,
    owner_session_id: input.owner_session_id,
    pinterest_user_id: input.pinterest_user_id || null,
    username: input.username || null,
    access_token_enc: encryptSecret(input.access_token),
    refresh_token_enc: encryptSecret(input.refresh_token),
    token_type: input.token_type || "bearer",
    scope: input.scope || "",
    connected_at: input.connected_at || new Date().toISOString()
  };

  if (memoryMode) {
    memory.set(row.credential_id, row);
    return normalize(row);
  }

  const result = await pool.query(
    `INSERT INTO pinterest_credentials
      (credential_id, owner_session_id, pinterest_user_id, username, access_token_enc,
       refresh_token_enc, token_type, scope, connected_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (credential_id) DO UPDATE SET
       owner_session_id=EXCLUDED.owner_session_id,
       pinterest_user_id=EXCLUDED.pinterest_user_id,
       username=EXCLUDED.username,
       access_token_enc=EXCLUDED.access_token_enc,
       refresh_token_enc=EXCLUDED.refresh_token_enc,
       token_type=EXCLUDED.token_type,
       scope=EXCLUDED.scope,
       connected_at=EXCLUDED.connected_at,
       updated_at=NOW(),
       revoked_at=NULL
     RETURNING *`,
    [
      row.credential_id, row.owner_session_id, row.pinterest_user_id, row.username,
      row.access_token_enc, row.refresh_token_enc, row.token_type, row.scope, row.connected_at
    ]
  );
  return normalize(result.rows[0]);
}

export async function getPinterestCredential(credentialId, ownerSessionId = null) {
  if (!credentialId) return null;

  if (memoryMode) {
    const row = memory.get(credentialId);
    if (!row || row.revoked_at) return null;
    if (ownerSessionId && row.owner_session_id !== ownerSessionId) return null;
    return normalize(row);
  }

  const result = await pool.query(
    `SELECT * FROM pinterest_credentials
      WHERE credential_id=$1
        AND revoked_at IS NULL
        AND ($2::text IS NULL OR owner_session_id=$2)
      LIMIT 1`,
    [credentialId, ownerSessionId]
  );
  return normalize(result.rows[0]);
}

export async function listPinterestCredentials(ownerSessionId) {
  if (memoryMode) {
    return [...memory.values()]
      .filter(row => row.owner_session_id === ownerSessionId && !row.revoked_at)
      .map(row => ({
        credential_id: row.credential_id,
        pinterest_user_id: row.pinterest_user_id || null,
        username: row.username || null,
        scope: row.scope,
        connected_at: row.connected_at
      }));
  }

  const result = await pool.query(
    `SELECT credential_id, pinterest_user_id, username, scope, connected_at
       FROM pinterest_credentials
      WHERE owner_session_id=$1 AND revoked_at IS NULL
      ORDER BY created_at ASC`,
    [ownerSessionId]
  );
  return result.rows;
}

export async function revokePinterestCredential(credentialId, ownerSessionId) {
  if (!credentialId) return false;

  if (memoryMode) {
    const row = memory.get(credentialId);
    if (!row || row.owner_session_id !== ownerSessionId) return false;
    row.revoked_at = new Date().toISOString();
    row.access_token_enc = null;
    row.refresh_token_enc = null;
    memory.set(credentialId, row);
    return true;
  }

  const result = await pool.query(
    `UPDATE pinterest_credentials
        SET revoked_at=NOW(), access_token_enc='', refresh_token_enc=NULL, updated_at=NOW()
      WHERE credential_id=$1 AND owner_session_id=$2 AND revoked_at IS NULL`,
    [credentialId, ownerSessionId]
  );
  return result.rowCount === 1;
}

export function _testDecrypt(value) {
  return decryptSecret(value);
}

export function _testEncrypt(value) {
  return encryptSecret(value);
}
