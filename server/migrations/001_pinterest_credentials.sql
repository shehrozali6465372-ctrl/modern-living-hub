-- Modern Living Hub: persistent encrypted Pinterest credential store.
-- Tokens are encrypted at the application layer before being written here.
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
