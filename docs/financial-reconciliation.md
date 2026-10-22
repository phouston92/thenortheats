# Financial reconciliation and administrator recovery

Implemented locally with deterministic provider doubles, typed SDK fixtures and SDK-signed synthetic webhooks. **No actual Stripe operation or delivery was verified.** Live API keys, live provider objects and live webhook events remain prohibited.

## Three distinct financial records

| Record                                    | Meaning                                                                                                                       | Financial treatment                                                                                                                                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing `ledger_entries` / invoice lines | Approved platform fees and their cumulative refunds/VAT                                                                       | Immutable, invoiceable. Completed cash accrues £1 customer + £1 partner fee; card completion accrues only £1 partner fee because the customer fee is allocated on the direct charge.                                     |
| `provider_balances` / payout links        | Authenticated Stripe connected-account balance transactions: gross, total fee, net, fee details, source and availability date | Immutable merchant cash evidence. Net must equal gross minus total fee. Never copied into platform invoices. Separate availability/status projections may refresh; the monetary record cannot be changed.                |
| `financial_adjustments`                   | Per-dispute merchant exposure memorandum, with debit, reversal or explicit correction reference                               | Immutable and idempotent. It is not a second bank movement, provider processing fee or invoice line. Actual chargeback/processing fees come from provider balance transactions. No invented VAT or fee-retention policy. |

`provider_events` stores immutable, deliberately selected evidence fields and source (`webhook` or authenticated `provider_read`). Raw Stripe objects, client secrets, PAN data, bank destinations and billing identities are not persisted here. `reconciliation_jobs` is a mutable workflow projection; every deferred/blocked record retains its original evidence. Duplicate event IDs and unique provider/financial references prevent duplicate effects. Wrong signatures/live events are rejected before persistence.

## External refunds and application fees

Dashboard refunds without API reservation metadata are associated only through a known PaymentIntent **and the snapshotted connected account**, positive GBP amount and remaining total. The refund gets an external-origin reservation and uses the same locked, cumulative immutable fee/VAT settlement as API refunds. Pending/failed states never credit fees. A success followed by stale pending/failure does not regress. A refund arriving before capture remains pending evidence; after signed/provider-read capture, the worker can replay it. Unknown payment/account, oversized or contradictory evidence stays visible for review; it is not guessed into a matching order.

For a Dashboard refund, `refund_service_fee=false` means the API did not request an application-fee refund; it is **not an observation that Stripe retained the fee**. Application-fee created/refunded events separately reconcile the actual fee and aggregate amount refunded against the known charge and exact order service fee. That aggregate does not prove an exact per-refund fee allocation. Online service fees never receive an additional platform invoice credit. Real refund/processing-fee behaviour still requires provider verification and policy approval.

`refund.failed` handles both API and Dashboard reservations. A terminal failure is not silently retried under another key. Already-pending unbound refunds remain ambiguous, especially after the provider key's 23-hour safety window. A provider read can discover and settle the original metadata-bound reservation; absence is not treated as permission to blindly issue another refund.

## Disputes, settlements and payouts

Disputes bind to a known charge/PaymentIntent in the same connected account, validate GBP amount and retain reason, evidence deadline and provider chronology. A debit/reversal/correction is appended once to merchant exposure history. Close-before-create and duplicate/old status events cannot multiply or regress that history. Terminal contradictions require a fresh authoritative read. Active/lost disputes block new API refunds and cancellation compensation, preventing automatic refund-plus-chargeback double repayment. Evidence submission and litigation/merchant communications are an operator workflow in Stripe's dashboard; this application does not submit evidence or decide legal liability.

Payout events retain account, amount, automatic/manual status, arrival date, failures and immutable event history. Old events do not downgrade a newer projection; same-second contradictory status evidence is quarantined. A later bank failure can replace an earlier paid status. `paid` is provider status, not independent proof of bank receipt.

A finance administrator retrieves an **automatic payout with completed Stripe reconciliation** and then its balance-transaction pages. Cursors must continue the recorded server cursor; a transaction can link to only one payout. Completion and net-match flags distinguish incomplete paging, matched net and mismatch. Manual payouts stay explicitly unallocated; no artificial allocation is inferred from matching amounts/dates. Settlement availability (`pending`/`available`) is recorded separately from immutable amounts. Account transactions without an attributable source are labelled unattributed rather than assigned to a customer order.

There is no invented balance-transaction webhook: `balance_transaction.snapshot` is an internal evidence kind accepted only from authenticated provider reads. Charge/payout webhooks and the finance dashboard provide visibility; settlement imports/payout paging are explicit administrator refreshes rather than an unverified background import from Stripe. Real provider keys are required.

## Safe workflows

Finance scope is mandatory; owner-only tenant views cannot read another partner's records. Each replay, provider refresh, evidence acknowledgement or recovery requires CSRF, a reason, fresh non-replayed TOTP and a shared per-user step-up limit. Requests and successful changes are audited. All Stripe refreshes are **reads**; none creates a payment, account, refund or payout.

- Finance → Stripe reconciliation lists pending/failed payments and refunds, unconfirmed captures, compensation blockers, inbox jobs, disputes, exposure adjustments, payouts, settlement entries and observed application fees.
- Refresh an order to retrieve its bound intent (or explicitly supply an interrupted unbound intent ID). Amount, currency, application fee, metadata order ID, account context and live-mode checks precede binding/settlement. More than one page of refunds/disputes is refused as incomplete rather than claimed fully reconciled.
- Replay only stored trusted evidence; malformed/conflicting evidence remains blocked. Automatic worker replay processes pending records, isolates failed jobs and does not force blocked records successful.
- Acknowledge an old conflict only with **processed, newer, same-account/same-object authenticated provider-read evidence**. The old immutable event remains; the projection links to its replacement and records the administrator/reason. Acknowledgement never fabricates a bank movement.
- Resume a blocked cancellation refund only after a complete provider check within five minutes, captured/cancelled order, no unresolved pending refund or active/lost dispute, and fresh provider confirmation of each old failed refund. A new key is then issued explicitly; the worker performs the authorised test refund. Fully refunded/nonblocked operations are rejected. Unknown/aged pending operations are not reset.
- Capture recovery requires a recent provider `requires_capture` observation, an existing interrupted capture and an active order. It rotates only that operation key; the ordinary capture endpoint still waits for signed/provider reconciliation before claiming payment or advancing fulfilment.

The provider and database are separate systems: HTTP timeouts can leave an ambiguous result. Refresh and reconcile first. Never edit financial history, delete a pending reservation, change a provider ID to work around a conflict or mark a refund successful by hand.

## Remaining production work

Real Standard account/controller and processing/refund/dispute fee evidence; actual provider delivery/3DS/capture/refund/payout tests; dashboard evidence-submission/legal ownership; automatic scheduled account-wide balance import and pagination beyond the bounded order snapshot; independently approved manual payout matching, formal credit-note/tax/legal treatment, operational response ownership and independent financial audit. The local suite verifies the implemented state/locking/idempotency rules, not those external or business prerequisites.

Failed/uncaptured charge attempts do not pin the canonical charge ID: a retried PaymentIntent may produce a different successful charge. Only captured evidence binds that identity. Unexpected partial external capture is quarantined for review rather than treated as fully paid.
