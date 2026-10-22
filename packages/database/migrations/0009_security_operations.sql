CREATE TABLE admin_mfa (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_ciphertext text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mfa_recovery_codes (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  PRIMARY KEY(user_id,code_hash)
);
CREATE TABLE mfa_rotations (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  session_hash text NOT NULL,
  secret_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0
);
-- Durable compensation requests survive API/worker interruption.
CREATE TABLE payment_compensations (
  order_id uuid PRIMARY KEY REFERENCES orders(id),
  request_key uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','succeeded','blocked')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_rate_limits (
  key_hash text PRIMARY KEY,
  attempts integer NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE partners ADD COLUMN stripe_onboarding_started_at timestamptz;
CREATE TABLE capture_operations (
  order_id uuid PRIMARY KEY REFERENCES orders(id),
  request_key uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Shared-secret administrator sessions must reauthenticate using individual credentials.
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role='admin');
