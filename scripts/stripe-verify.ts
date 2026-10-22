import { StripeProvider } from "../packages/payments/src/index";
// Read-only by construction. Real provider writes are a separate explicitly documented procedure.
const present = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_TEST_ACCOUNT_ID",
].map((name) => ({ name, present: Boolean(process.env[name]) }));
if (present.some((p) => !p.present)) {
  console.log(
    JSON.stringify(
      {
        providerTestsRun: false,
        reason: "Private test credentials/configuration absent",
        requirements: present,
      },
      null,
      2,
    ),
  );
  process.exitCode = 2;
} else {
  if (!process.env.STRIPE_PUBLISHABLE_KEY!.startsWith("pk_test_"))
    throw new Error("Test publishable key required");
  const provider = new StripeProvider(),
    account = await provider.ready(process.env.STRIPE_TEST_ACCOUNT_ID!);
  console.log(
    JSON.stringify(
      {
        providerReadVerified: true,
        testModeOnly: true,
        accountType: account.type,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        feePayer: account.controller?.fees?.payer,
        lossResponsibility: account.controller?.losses?.payments,
        providerPaymentTestsRun: false,
      },
      null,
      2,
    ),
  );
}
