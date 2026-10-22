# Stripe Connect — provisional test implementation

## Model selection and evidence limits

The adapter selects **direct charges on Standard connected accounts**, with an application fee equal to the customer service fee. It creates the PaymentIntent with `stripeAccount` context and `application_fee_amount`; food and delivery revenue stay on the connected account. The partner completed-order fee is invoiced separately, never put into the customer service fee. Only `sk_test_` keys are accepted; live webhook events are rejected.

Reference documentation: https://docs.stripe.com/connect/direct-charges and https://docs.stripe.com/connect/charges-transfers. The public direct-charge and direct-charge fee-payer documentation was read during the stabilisation review on 22 October 2026. It confirms connected-account-scoped objects and explicit application-fee refunds; with Accounts v1 `controller.fees.payer=account`, the application fee should contain only the platform fee, while Stripe deducts processing fees separately. This agrees with the adapter. A real test-account verification and country/contract review still remain prerequisites. Do not treat this document as a confirmed Connect agreement.

Account readiness checks require `type=standard`, charges/payouts enabled, `controller.fees.payer=account`, and `controller.losses.payments=stripe`. The implementation fails closed for unsupported configurations. These checks make the intended allocation explicit instead of assuming all Connect models allocate fees and losses alike. No account was actually connected or tested.

## Responsibility to verify with Stripe

With this intended direct-charge model, processing charges and payment/refund/dispute debits are expected on the connected account; Stripe, rather than this platform, is expected to be responsible for connected-account payment losses for the supported controller configuration. The platform still owns its application-fee income and any fee refunds it elects to make. Processing-fee return on refunds, dispute charges, negative-balance recovery, contractual liability, and any exceptional platform obligations depend on Stripe's current terms, account configuration and country; they are unverified and require Stripe confirmation. Never activate a different Connect account model silently.

The adapter supports intent creation, capture, explicit partial/full refunds and a provisional account-link method, but onboarding endpoints, Stripe UI, disputes and comprehensive settlement/reconciliation jobs are unfinished. Immediate intents use automatic capture. Scheduled payment authorisation/capacity/recovery is not implemented and scheduled checkout is blocked.

## Reliability

Intent keys are stable per order and provider calls occur outside SQL transactions; retries recover using the same intent key and the snapshotted payment account. Payment state comes from verified webhooks, not browser messages. Duplicate events are ignored transactionally. Account, GBP amount and captured amount must reconcile. A late failure cannot downgrade capture.

Refunds reserve a unique key and amount under an order lock before calling the provider, with at most one pending refund per order. Retries reuse the same provider key. Failed refund keys are terminal; a new key requires a deliberate reconciled retry. Successful refunds create cumulative proportional partner-fee credits without penny drift. `refundServiceFee` must be explicit and is snapshotted; when true, Stripe is asked to proportionally refund its application fee. This interface does not yet support independently choosing an exact service-fee refund amount. Signed refund webhooks can recover a lost provider-ID response through reserved refund-request metadata, after checking connected account, payment intent, GBP currency and exact amount. Receipt deduplication, fee credits, audit records and both payment-state records commit atomically. Stale HTTP/pending/failure responses cannot downgrade settled refunds. Disputes and external Dashboard refunds are not reconciled automatically. These are staging blockers.

Rejection/cancellation does not automatically refund captured payments. An administrator must perform a separate audited refund, and this limitation must be resolved before real ordering. Cash refunds are rejected until confirmed repayment and allocation rules exist. No raw card data is collected or stored.

Tests use an explicitly injected deterministic provider and official SDK-generated webhook signatures. They do not prove Stripe account onboarding, liability, capture, refund or payouts against the external service.

## Stabilisation safeguards

Known PaymentIntents are retrieved in their snapshotted connected account rather than recreated with a potentially expired idempotency key. Unbound interrupted attempts older than 23 hours fail closed for reconciliation (Stripe can prune keys after 24 hours). Retrieved intent amount, currency, application fee and order metadata must match before returning a client secret. A checkout replay also requires the same authenticated customer identity. Payment webhooks check the service-fee allocation and cannot restore a refunded payment on a new-event-ID replay.

Configured VAT reversal is cumulative. New ledger entries carry explicit tax amounts; invoices use these snapshots. Credit rounding is derived from original tax and previous recorded reversals so a full reversal cannot create an extra VAT penny. Legacy NULL tax snapshots retain the original calculation; no historical ledger or issued invoice is rewritten. This is numerical correctness under explicit test/configured rates, not an assertion about UK VAT treatment. Accountant approval is still required.

Pending refunds with a known provider ID return the stored pending result instead of issuing another create request. Unbound interrupted refunds older than 23 hours also fail closed, preventing an expired Stripe idempotency key from creating a second refund. Signed matching events can still reconcile those reservations; tests cover both known-pending retries and aged lost-response recovery.
