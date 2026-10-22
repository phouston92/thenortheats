CREATE FUNCTION require_admin_permission_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND role='admin') THEN RAISE EXCEPTION 'platform grants require administrator role' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER permission_role BEFORE INSERT OR UPDATE ON admin_permissions FOR EACH ROW EXECUTE FUNCTION require_admin_permission_role();
CREATE FUNCTION clear_nonadmin_grants() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.role<>'admin' THEN DELETE FROM admin_permissions WHERE user_id=NEW.id; END IF; RETURN NEW; END $$;
CREATE TRIGGER clear_admin_grants AFTER UPDATE OF role ON users FOR EACH ROW EXECUTE FUNCTION clear_nonadmin_grants();
CREATE FUNCTION guard_provider_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='provider_payouts' THEN
  IF (NEW.account,NEW.provider_id,NEW.partner_id,NEW.amount,NEW.currency,NEW.automatic) IS DISTINCT FROM (OLD.account,OLD.provider_id,OLD.partner_id,OLD.amount,OLD.currency,OLD.automatic) THEN RAISE EXCEPTION 'immutable payout identity and amount'; END IF;
 ELSIF TG_TABLE_NAME='provider_disputes' THEN
  IF (NEW.account,NEW.provider_id,NEW.order_id,NEW.amount,NEW.currency) IS DISTINCT FROM (OLD.account,OLD.provider_id,OLD.order_id,OLD.amount,OLD.currency) THEN RAISE EXCEPTION 'immutable dispute identity and amount'; END IF;
 ELSIF TG_TABLE_NAME='provider_application_fees' THEN
  IF (NEW.provider_id,NEW.account,NEW.order_id,NEW.amount) IS DISTINCT FROM (OLD.provider_id,OLD.account,OLD.order_id,OLD.amount) OR NEW.amount_refunded<OLD.amount_refunded THEN RAISE EXCEPTION 'immutable application fee identity or refund regression'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payout_financial_identity BEFORE UPDATE ON provider_payouts FOR EACH ROW EXECUTE FUNCTION guard_provider_projection();
CREATE TRIGGER dispute_financial_identity BEFORE UPDATE ON provider_disputes FOR EACH ROW EXECUTE FUNCTION guard_provider_projection();
CREATE TRIGGER application_fee_financial_identity BEFORE UPDATE ON provider_application_fees FOR EACH ROW EXECUTE FUNCTION guard_provider_projection();
