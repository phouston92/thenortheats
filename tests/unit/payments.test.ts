import { afterEach, describe, it, expect, vi } from "vitest";
import type Stripe from "stripe";
import { StripeProvider } from "../../packages/payments/src/index";
const account: Stripe.Account = {
  id: "acct_fixture",
  object: "account",
  charges_enabled: true,
  payouts_enabled: true,
  details_submitted: true,
  email: null,
  type: "standard",
  controller: {
    type: "account",
    fees: { payer: "account" },
    losses: { payments: "stripe" },
  },
};
const response: Stripe.Response<Stripe.Account> = {
  ...account,
  lastResponse: { headers: {}, requestId: "req_fixture", statusCode: 200 },
};
afterEach(() => vi.restoreAllMocks());
describe("Stripe test-only direct charge allocation", () => {
  it("rejects production keys", () => {
    expect(() => new StripeProvider("sk_live_not_a_credential")).toThrow(
      "test key required",
    );
  });
  it("allocates only the customer service fee, in the connected account context", async () => {
    const p = new StripeProvider("sk_test_fixture");
    vi.spyOn(p.stripe.accounts, "retrieve").mockResolvedValue(response);
    const stop = new Error("stop before any network call");
    const create = vi
      .spyOn(p.stripe.paymentIntents, "create")
      .mockRejectedValue(stop);
    await expect(
      p.intent(
        { id: "order_fixture", total: 1250, service_fee: 100 },
        account.id,
      ),
    ).rejects.toBe(stop);
    expect(create).toHaveBeenCalledWith(
      {
        amount: 1250,
        currency: "gbp",
        application_fee_amount: 100,
        automatic_payment_methods: { enabled: true },
        metadata: { orderId: "order_fixture" },
      },
      { stripeAccount: account.id, idempotencyKey: "order:order_fixture" },
    );
    expect(create.mock.calls[0][0]).not.toHaveProperty("transfer_data");
  });
  it.each<Partial<Stripe.Account>>([
    { charges_enabled: false },
    { payouts_enabled: false },
    { type: "express" },
    {
      controller: {
        type: "application",
        fees: { payer: "application" },
        losses: { payments: "stripe" },
      },
    },
    {
      controller: {
        type: "account",
        fees: { payer: "account" },
        losses: { payments: "application" },
      },
    },
    { controller: undefined },
  ])(
    "fails closed for unsupported account readiness/controller configuration %j",
    async (changes) => {
      const p = new StripeProvider("sk_test_fixture");
      vi.spyOn(p.stripe.accounts, "retrieve").mockResolvedValue({
        ...response,
        ...changes,
      });
      const create = vi.spyOn(p.stripe.paymentIntents, "create");
      await expect(
        p.intent(
          { id: "order_fixture", total: 1050, service_fee: 100 },
          account.id,
        ),
      ).rejects.toThrow("Standard account");
      expect(create).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])(
    "refunds fees only when explicitly requested: %s",
    async (refundServiceFee) => {
      const p = new StripeProvider("sk_test_fixture");
      const stop = new Error("no network");
      const refund = vi
        .spyOn(p.stripe.refunds, "create")
        .mockRejectedValue(stop);
      await expect(
        p.refund(
          "pi_fixture",
          account.id,
          350,
          "request_fixture",
          refundServiceFee,
        ),
      ).rejects.toBe(stop);
      expect(refund).toHaveBeenCalledWith(
        {
          payment_intent: "pi_fixture",
          amount: 350,
          refund_application_fee: refundServiceFee,
          metadata: { refundRequestKey: "request_fixture" },
        },
        { stripeAccount: account.id, idempotencyKey: "request_fixture" },
      );
    },
  );
  it("retrieves a persisted intent rather than relying on an expiring creation key", async () => {
    const p = new StripeProvider("sk_test_fixture");
    vi.spyOn(p.stripe.accounts, "retrieve").mockResolvedValue(response);
    const stop = new Error("no network");
    const retrieve = vi
      .spyOn(p.stripe.paymentIntents, "retrieve")
      .mockRejectedValue(stop);
    const create = vi.spyOn(p.stripe.paymentIntents, "create");
    await expect(
      p.intent(
        { id: "order_fixture", total: 1050, service_fee: 100 },
        account.id,
        "pi_existing",
      ),
    ).rejects.toBe(stop);
    expect(retrieve).toHaveBeenCalledWith(
      "pi_existing",
      {},
      { stripeAccount: account.id },
    );
    expect(create).not.toHaveBeenCalled();
  });

  function intentResponse(
    changes: Partial<Stripe.PaymentIntent> = {},
  ): Stripe.Response<Stripe.PaymentIntent> {
    return {
      id: "pi_existing",
      object: "payment_intent",
      amount: 1050,
      amount_capturable: 0,
      amount_received: 0,
      application: null,
      application_fee_amount: 100,
      automatic_payment_methods: null,
      canceled_at: null,
      cancellation_reason: null,
      capture_method: "automatic",
      client_secret: "fixture_secret",
      confirmation_method: "automatic",
      created: 0,
      currency: "gbp",
      customer: null,
      customer_account: null,
      description: null,
      excluded_payment_method_types: null,
      last_payment_error: null,
      latest_charge: null,
      livemode: false,
      metadata: { orderId: "order_fixture" },
      next_action: null,
      on_behalf_of: null,
      payment_method: null,
      payment_method_configuration_details: null,
      payment_method_options: null,
      payment_method_types: ["card"],
      processing: null,
      receipt_email: null,
      review: null,
      setup_future_usage: null,
      shipping: null,
      source: null,
      statement_descriptor: null,
      statement_descriptor_suffix: null,
      status: "requires_payment_method",
      transfer_group: null,
      ...changes,
      lastResponse: { headers: {}, requestId: "req_fixture", statusCode: 200 },
    };
  }
  it("returns a known matching intent without creating a second payment", async () => {
    const p = new StripeProvider("sk_test_fixture");
    vi.spyOn(p.stripe.accounts, "retrieve").mockResolvedValue(response);
    vi.spyOn(p.stripe.paymentIntents, "retrieve").mockResolvedValue(
      intentResponse(),
    );
    const create = vi.spyOn(p.stripe.paymentIntents, "create");
    await expect(
      p.intent(
        { id: "order_fixture", total: 1050, service_fee: 100 },
        account.id,
        "pi_existing",
      ),
    ).resolves.toEqual({ id: "pi_existing", clientSecret: "fixture_secret" });
    expect(create).not.toHaveBeenCalled();
  });
  it.each<Partial<Stripe.PaymentIntent>>([
    { amount: 1051 },
    { currency: "usd" },
    { application_fee_amount: 99 },
    { metadata: { orderId: "another_order" } },
  ])(
    "does not expose a client secret from a mismatched persisted intent %j",
    async (changes) => {
      const p = new StripeProvider("sk_test_fixture");
      vi.spyOn(p.stripe.accounts, "retrieve").mockResolvedValue(response);
      vi.spyOn(p.stripe.paymentIntents, "retrieve").mockResolvedValue(
        intentResponse(changes),
      );
      await expect(
        p.intent(
          { id: "order_fixture", total: 1050, service_fee: 100 },
          account.id,
          "pi_existing",
        ),
      ).rejects.toThrow("reconciliation mismatch");
    },
  );
});
