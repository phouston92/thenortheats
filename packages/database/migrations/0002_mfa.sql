CREATE TABLE mfa_uses(user_id uuid NOT NULL REFERENCES users(id),counter bigint NOT NULL,PRIMARY KEY(user_id,counter));
