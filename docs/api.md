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

Only immediate checkout is enabled. Scheduled orders fail explicitly. Card intent creation is API infrastructure only, with test keys required and a ready Standard connected account. There is no working customer card payment UI or account onboarding UI.

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
