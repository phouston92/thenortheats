CREATE TABLE payout_reconciliation (
  account text NOT NULL,
  payout_id text NOT NULL,
  next_cursor text,
  complete boolean NOT NULL DEFAULT false,
  net_matches boolean,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account,payout_id),
  FOREIGN KEY(account,payout_id) REFERENCES provider_payouts(account,provider_id)
);
