# API

Run `pnpm dev:api`. `GET /api/docs` returns generated OpenAPI JSON. It enumerates the current routes; detailed response schemas/examples and a complete generated client are pending. Zod validates mutation inputs; validation errors return 400, role/tenant/CSRF failures 403, missing sessions 401, conflicts 409, disabled capabilities 422 or 503. Unhandled errors return a generic response and logs omit request payloads.

- Health: `GET /api/health`, `GET /api/ready` (database readiness; Redis is not checked).
- Auth: `POST /api/auth/request`, `/verify`, `/logout`; `GET /api/auth/me` supplies role, partner memberships and CSRF token. Session cookie is HttpOnly and SameSite Strict. Mutation requests with sessions require `x-csrf-token`.
- Discovery: `GET /api/towns`, `/partners?town=Lancaster`, `/partners/:id/menu`.
- Checkout: `POST /api/orders` with UUID `idempotency-key` and cryptographically random 64-hex `x-order-token`. Prices come from the database; clients never choose totals. `GET /api/orders/:id` needs that capability or an authorised session. Never put guest capabilities in query strings/logs. `GET /api/account/orders` lists the signed-in user's orders.
- Administration: `/api/admin/summary`, `/partners`, `/customers`, `/orders`, `/finance`, `/audit`, `/integrations`; create towns/staff, append approved partner pricing, set partner status and generate closed-week draft invoices.
- Partner: `/api/partner/:id`, `/settings`, `/products`, `/orders`, `/orders/:orderId/transition`, `/finance`.
- Finance: `GET /api/invoices/:id`; `POST /api/admin/orders/:id/refund` with amount, UUID requestKey and an explicit refundServiceFee choice. Cash refunds are rejected until repayment confirmation is implemented.
- Stripe: `POST /api/webhooks/stripe` verifies the original raw body signature, refuses live events, deduplicates event IDs, validates connected account/currency/amount and cannot downgrade captured/refunded payments on a late failure.
- Support: list/create tickets; read/add authorised ticket messages.

Only immediate checkout is enabled. Scheduled orders fail explicitly. Stripe test card checkout and owner onboarding UI are implemented. They require configured test credentials and a supported Standard account; external provider verification remains blocked.

## Example cash checkout body

```json
{
  "partnerId": "10000000-0000-4000-8000-000000000001",
  "items": [
    { "productId": "10000000-0000-4000-8000-000000000003", "quantity": 1 }
  ],
  "customerName": "Development Customer",
  "customerEmail": "buyer@example.test",
  "fulfilment": "collection",
  "paymentMethod": "cash"
}
```

The partner must first have approved pricing and active status. Example is data, not a claim that the seed automatically enables ordering.

## Payment/security follow-up routes

- `GET /api/auth/mfa`: own enrollment status/recovery count (admin only).
- `POST /api/auth/mfa/rotate`: fresh current TOTP starts a session-bound ten-minute rotation; `/confirm` validates the new TOTP, revokes all sessions and returns recovery codes once. `POST /api/auth/verify` optionally accepts one recoveryCode instead of mfa, alongside email OTP.
- `POST /api/auth/sessions/revoke`: invalidate other sessions for the current user.
- Owner/admin `GET /api/partner/:id/payments/readiness`, `POST /api/partner/:id/payments/onboarding`: test-only Standard Connect flow with trusted configured return URLs.
- `POST /api/orders/:id/payment`: same guest capability or owning customer session/CSRF resumes a card intent; no new order is created. The response includes only a test publishable key, intent client secret and connected-account context; treat the client secret as private.
- Owner/admin `POST /api/partner/:id/orders/:orderId/capture`: capture an authorised active order using a durable key; returns awaiting_webhook, never claims settlement from HTTP alone.
- `GET /api/admin/payments/compensations`: outstanding automatic cancellation/refund work and reconciliation blockers. Signed reconciliation/refund settlement resolves corresponding financial state; no endpoint can simply mark provider work successful.
