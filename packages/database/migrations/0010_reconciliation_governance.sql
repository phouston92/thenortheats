-- Provider evidence is append-only. Mutable rows are rebuildable workflow projections.
ALTER TABLE payments ADD COLUMN charge_id text UNIQUE;
ALTER TABLE refunds ADD COLUMN origin text NOT NULL DEFAULT 'api' CHECK(origin IN ('api','dashboard'));
CREATE TABLE provider_events (
  event_id text PRIMARY KEY,
  account text NOT NULL,
  kind text NOT NULL,
  provider_created bigint NOT NULL,
  source text NOT NULL CHECK(source IN ('webhook','provider_read')),
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER provider_events_immutable BEFORE UPDATE OR DELETE ON provider_events FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TABLE reconciliation_jobs (
  event_id text PRIMARY KEY REFERENCES provider_events(event_id),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processed','blocked')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reconciliation_pending_idx ON reconciliation_jobs(state,updated_at);
CREATE TABLE provider_balances (
  account text NOT NULL,
  provider_id text NOT NULL,
  partner_id uuid NOT NULL REFERENCES partners(id),
  source_id text NOT NULL,
  amount integer NOT NULL,
  fee integer NOT NULL,
  net integer NOT NULL CHECK(net=amount-fee),
  currency text NOT NULL CHECK(currency='gbp'),
  category text NOT NULL,
  fee_details jsonb NOT NULL,
  available_on bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account,provider_id)
);
CREATE TRIGGER provider_balances_immutable BEFORE UPDATE OR DELETE ON provider_balances FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TABLE provider_payouts (
  account text NOT NULL,
  provider_id text NOT NULL,
  partner_id uuid NOT NULL REFERENCES partners(id),
  amount integer NOT NULL CHECK(amount>0),
  currency text NOT NULL CHECK(currency='gbp'),
  status text NOT NULL,
  automatic boolean NOT NULL,
  arrival_date bigint NOT NULL,
  balance_transaction text,
  failure_code text,
  last_event_created bigint NOT NULL,
  last_event_id text NOT NULL REFERENCES provider_events(event_id),
  PRIMARY KEY(account,provider_id)
);
CREATE TABLE payout_balance_links (
  account text NOT NULL,
  payout_id text NOT NULL,
  balance_id text NOT NULL,
  PRIMARY KEY(account,payout_id,balance_id),
  UNIQUE(account,balance_id),
  FOREIGN KEY(account,payout_id) REFERENCES provider_payouts(account,provider_id),
  FOREIGN KEY(account,balance_id) REFERENCES provider_balances(account,provider_id)
);
CREATE TRIGGER payout_links_immutable BEFORE UPDATE OR DELETE ON payout_balance_links FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TABLE provider_disputes (
  account text NOT NULL,
  provider_id text NOT NULL,
  order_id uuid NOT NULL REFERENCES orders(id),
  amount integer NOT NULL CHECK(amount>0),
  currency text NOT NULL CHECK(currency='gbp'),
  status text NOT NULL,
  reason text NOT NULL,
  evidence_due_by bigint,
  last_event_created bigint NOT NULL,
  last_event_id text NOT NULL REFERENCES provider_events(event_id),
  PRIMARY KEY(account,provider_id)
);
-- Merchant exposure memorandum, NOT an invoice or a second Stripe cash movement.
CREATE TABLE financial_adjustments (
  reference text PRIMARY KEY,
  account text NOT NULL,
  dispute_id text NOT NULL,
  partner_id uuid NOT NULL REFERENCES partners(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  amount integer NOT NULL CHECK(amount<>0),
  kind text NOT NULL CHECK(kind IN ('dispute_debit','dispute_reversal','dispute_correction')),
  event_id text NOT NULL REFERENCES provider_events(event_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(account,dispute_id) REFERENCES provider_disputes(account,provider_id)
);
CREATE TRIGGER financial_adjustments_immutable BEFORE UPDATE OR DELETE ON financial_adjustments FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TABLE provider_application_fees (
  provider_id text PRIMARY KEY,
  account text NOT NULL,
  order_id uuid NOT NULL REFERENCES orders(id),
  amount integer NOT NULL CHECK(amount>=0),
  amount_refunded integer NOT NULL CHECK(amount_refunded>=0 AND amount_refunded<=amount),
  last_event_id text NOT NULL REFERENCES provider_events(event_id)
);
CREATE TABLE admin_permissions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission text NOT NULL CHECK(permission IN ('operations','finance','support','governance')),
  PRIMARY KEY(user_id,permission)
);
INSERT INTO admin_permissions SELECT id,p FROM users CROSS JOIN unnest(ARRAY['operations','finance','support','governance']) p WHERE role='admin';
CREATE FUNCTION revoke_permission_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN DELETE FROM sessions WHERE user_id=COALESCE(NEW.user_id,OLD.user_id); RETURN NULL; END $$;
CREATE TRIGGER admin_permissions_revoke AFTER INSERT OR UPDATE OR DELETE ON admin_permissions FOR EACH ROW EXECUTE FUNCTION revoke_permission_sessions();
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role='admin');
-- Defence in depth without rewriting historic immutable financial rows.
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_order_tenant FOREIGN KEY(order_id,partner_id) REFERENCES orders(id,partner_id) NOT VALID;
ALTER TABLE ledger_entries VALIDATE CONSTRAINT ledger_order_tenant;
CREATE FUNCTION guard_item_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM orders o JOIN products p ON p.partner_id=o.partner_id WHERE o.id=NEW.order_id AND p.id=NEW.product_id) THEN RAISE EXCEPTION 'cross-tenant order item' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER item_tenant BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION guard_item_tenant();
CREATE FUNCTION guard_invoice_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM invoices i JOIN ledger_entries l ON l.partner_id=i.partner_id WHERE i.id=NEW.invoice_id AND l.id=NEW.ledger_id) THEN RAISE EXCEPTION 'cross-tenant invoice line' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invoice_line_tenant BEFORE INSERT ON invoice_lines FOR EACH ROW EXECUTE FUNCTION guard_invoice_tenant();
CREATE FUNCTION guard_product_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.partner_id<>OLD.partner_id THEN RAISE EXCEPTION 'product tenant is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER product_tenant BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION guard_product_tenant();
ALTER TABLE financial_adjustments ADD CONSTRAINT adjustment_order_tenant FOREIGN KEY(order_id,partner_id) REFERENCES orders(id,partner_id);
CREATE TABLE provider_order_checks (
  order_id uuid PRIMARY KEY REFERENCES orders(id),
  payment_status text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  event_id text NOT NULL REFERENCES provider_events(event_id)
);
ALTER TABLE reconciliation_jobs ADD COLUMN resolved_by_event text REFERENCES provider_events(event_id);
CREATE TRIGGER memberships_revoke AFTER INSERT OR UPDATE OR DELETE ON memberships FOR EACH ROW EXECUTE FUNCTION revoke_permission_sessions();
