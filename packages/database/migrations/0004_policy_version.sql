-- Reject ambiguous equal-effective policies rather than choosing a random UUID.
CREATE UNIQUE INDEX policy_partner_effective_unique ON fee_policies(partner_id,effective_at);
