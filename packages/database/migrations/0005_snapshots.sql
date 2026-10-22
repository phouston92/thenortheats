CREATE FUNCTION protect_order_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.partner_id,NEW.customer_id,NEW.tracking_hash,NEW.request_key,NEW.request_hash,
         NEW.subtotal,NEW.delivery_fee,NEW.service_fee,NEW.partner_fee,NEW.total,
         NEW.pricing_snapshot,NEW.payment_method,NEW.fulfilment,NEW.address)
     IS DISTINCT FROM
     ROW(OLD.partner_id,OLD.customer_id,OLD.tracking_hash,OLD.request_key,OLD.request_hash,
         OLD.subtotal,OLD.delivery_fee,OLD.service_fee,OLD.partner_fee,OLD.total,
         OLD.pricing_snapshot,OLD.payment_method,OLD.fulfilment,OLD.address) THEN
    RAISE EXCEPTION 'immutable order snapshot';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_snapshot_immutable BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION protect_order_snapshot();
CREATE TRIGGER order_items_immutable BEFORE UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE FUNCTION protect_invoice_totals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.number,NEW.partner_id,NEW.period_start,NEW.period_end,NEW.net,NEW.vat,NEW.total)
     IS DISTINCT FROM
     ROW(OLD.number,OLD.partner_id,OLD.period_start,OLD.period_end,OLD.net,OLD.vat,OLD.total) THEN
    RAISE EXCEPTION 'immutable invoice totals';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_totals_immutable BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION protect_invoice_totals();
