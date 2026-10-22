-- Close any pre-existing role-change/MFA session gap when upgrading the baseline.
-- Deliberately signs out existing users once; subsequent runs are migration no-ops.
DELETE FROM sessions;
