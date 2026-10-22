import Stripe from "stripe";
export interface PaymentProvider {
  intent(
    order: { id: string; total: number; service_fee: number },
    account: string,
    existingIntentId?: string,
  ): Promise<{ id: string; clientSecret: string | null }>;
  refund(
    intent: string,
    account: string,
    amount: number,
    key: string,
    refundServiceFee: boolean,
  ): Promise<{ id: string; status: string }>;
  cancel?(
    intent: string,
    account: string,
    key: string,
  ): Promise<"cancelled" | "captured">;
  capture(intent: string, account: string, key: string): Promise<void>;
}
export class StripeProvider implements PaymentProvider {
  readonly stripe: Stripe;
  constructor(key = process.env.STRIPE_SECRET_KEY) {
    if (!key?.startsWith("sk_test_"))
      throw new Error("Stripe test key required; production disabled");
    this.stripe = new Stripe(key, { maxNetworkRetries: 2, timeout: 10000 });
  }
  async ready(account: string) {
    const a = await this.stripe.accounts.retrieve(account);
    if (
      !a.charges_enabled ||
      !a.payouts_enabled ||
      a.type !== "standard" ||
      a.controller?.fees?.payer !== "account" ||
      a.controller?.losses?.payments !== "stripe"
    )
      throw new Error(
        "Standard account with connected-account fee responsibility and Stripe loss liability required",
      );
    return a;
  }
  async intent(
    order: { id: string; total: number; service_fee: number },
    account: string,
    existingIntentId?: string,
  ) {
    await this.ready(account);
    const p = existingIntentId
      ? await this.stripe.paymentIntents.retrieve(
          existingIntentId,
          {},
          { stripeAccount: account },
        )
      : await this.stripe.paymentIntents.create(
          {
            amount: order.total,
            currency: "gbp",
            application_fee_amount: order.service_fee,
            payment_method_types: ["card"],
            metadata: { orderId: order.id },
          },
          { stripeAccount: account, idempotencyKey: "order:" + order.id },
        );
    if (
      p.livemode ||
      p.amount !== order.total ||
      p.currency !== "gbp" ||
      (p.application_fee_amount ?? 0) !== order.service_fee ||
      p.metadata.orderId !== order.id
    )
      throw new Error("Payment intent reconciliation mismatch");
    return { id: p.id, clientSecret: p.client_secret };
  }
  async cancel(
    intent: string,
    account: string,
    key: string,
  ): Promise<"cancelled" | "captured"> {
    const p = await this.stripe.paymentIntents.retrieve(
      intent,
      {},
      { stripeAccount: account },
    );
    if (p.status === "succeeded") return "captured";
    if (p.status !== "canceled")
      await this.stripe.paymentIntents.cancel(
        intent,
        {},
        { stripeAccount: account, idempotencyKey: key },
      );
    return "cancelled";
  }
  async capture(intent: string, account: string, key: string) {
    await this.stripe.paymentIntents.capture(
      intent,
      {},
      { stripeAccount: account, idempotencyKey: key },
    );
  }
  async refund(
    intent: string,
    account: string,
    amount: number,
    key: string,
    refundServiceFee: boolean,
  ) {
    const r = await this.stripe.refunds.create(
      {
        payment_intent: intent,
        amount,
        refund_application_fee: refundServiceFee,
        metadata: { refundRequestKey: key },
      },
      { stripeAccount: account, idempotencyKey: key },
    );
    return { id: r.id, status: r.status || "pending" };
  }
  async reconciliationSnapshot(account: string, intentId: string) {
    const options = { stripeAccount: account };
    const intent = await this.stripe.paymentIntents.retrieve(
      intentId,
      { expand: ["latest_charge.balance_transaction"] },
      options,
    );
    if (intent.livemode) throw new Error("Live provider object disabled");
    const charge =
      typeof intent.latest_charge === "object" ? intent.latest_charge : null;
    const refunds = await this.stripe.refunds.list(
      { payment_intent: intentId, limit: 100 },
      options,
    );
    const disputes = charge
      ? await this.stripe.disputes.list(
          { charge: charge.id, limit: 100 },
          options,
        )
      : { data: [], has_more: false };
    if (refunds.has_more || disputes.has_more)
      throw new Error(
        "Provider pagination requires explicit account reconciliation; snapshot incomplete",
      );
    return { intent, charge, refunds: refunds.data, disputes: disputes.data };
  }
  async payoutSnapshot(account: string, payoutId: string, cursor?: string) {
    const options = { stripeAccount: account };
    const payout = await this.stripe.payouts.retrieve(payoutId, {}, options);
    if (payout.livemode) throw new Error("Live provider object disabled");
    if (payout.automatic && payout.reconciliation_status !== "completed")
      throw new Error(
        "Stripe payout reconciliation is not complete; retry after provider completion",
      );
    const balances = payout.automatic
      ? await this.stripe.balanceTransactions.list(
          {
            payout: payout.id,
            limit: 100,
            ...(cursor ? { starting_after: cursor } : {}),
          },
          options,
        )
      : { data: [], has_more: false };
    return {
      payout,
      balances: balances.data,
      hasMore: balances.has_more,
      nextCursor: balances.has_more ? balances.data.at(-1)?.id : null,
    };
  }
  async createAccount(partnerId: string) {
    return this.stripe.accounts.create(
      { type: "standard", country: "GB", metadata: { partnerId } },
      { idempotencyKey: "connect:" + partnerId },
    );
  }
  async onboarding(account: string, refreshUrl: string, returnUrl: string) {
    const a = await this.stripe.accounts.retrieve(account);
    if (
      a.type !== "standard" ||
      a.controller?.fees?.payer !== "account" ||
      a.controller?.losses?.payments !== "stripe"
    )
      throw new Error("Unsupported connected account configuration");
    return this.stripe.accountLinks.create({
      account,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: "account_onboarding",
    });
  }
}
