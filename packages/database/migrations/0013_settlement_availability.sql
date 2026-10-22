CREATE TABLE provider_balance_status (
 account text NOT NULL,
 provider_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','available')),
 event_id text NOT NULL REFERENCES provider_events(event_id),
 checked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account,provider_id),
 FOREIGN KEY(account,provider_id) REFERENCES provider_balances(account,provider_id)
);
