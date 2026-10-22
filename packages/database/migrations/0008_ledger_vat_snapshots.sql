-- Preserve tax rounding on new fee/credit entries without mutating legacy history.
-- NULL retains the original per-line calculation for pre-existing ledger entries.
ALTER TABLE ledger_entries ADD COLUMN vat_amount integer;
