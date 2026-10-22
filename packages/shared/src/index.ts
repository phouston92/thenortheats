export type OrderState =
  | "awaiting_payment"
  | "awaiting_acceptance"
  | "accepted"
  | "rejected"
  | "preparing"
  | "ready"
  | "out_for_delivery"
  | "completed"
  | "cancelled"
  | "refund_pending"
  | "refunded";
const transitions: Record<OrderState, OrderState[]> = {
  awaiting_payment: ["awaiting_acceptance", "cancelled"],
  awaiting_acceptance: ["accepted", "rejected", "cancelled"],
  accepted: ["preparing", "cancelled"],
  preparing: ["ready", "out_for_delivery", "cancelled"],
  ready: ["completed", "cancelled"],
  out_for_delivery: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  rejected: [],
  refund_pending: [],
  refunded: [],
};
export function canTransition(
  from: OrderState,
  to: OrderState,
  fulfilment: string,
) {
  return (
    transitions[from]?.includes(to) &&
    !(to === "ready" && fulfilment !== "collection") &&
    !(to === "out_for_delivery" && fulfilment !== "delivery")
  );
}
export function integer(value: number) {
  if (!Number.isSafeInteger(value)) throw new Error("Unsafe minor-unit amount");
  return value;
}
export function ratio(amount: number, numerator: number, denominator: number) {
  integer(amount);
  integer(numerator);
  integer(denominator);
  if (denominator <= 0 || numerator < 0 || numerator > denominator)
    throw new Error("Invalid ratio");
  const sign = amount < 0 ? -1 : 1;
  return integer(
    sign *
      Number(
        (BigInt(Math.abs(amount)) * BigInt(numerator) +
          BigInt(Math.floor(denominator / 2))) /
          BigInt(denominator),
      ),
  );
}
export function partnerFee(
  subtotal: number,
  p: {
    fixed_fee: number;
    basis_points: number;
    minimum_fee: number;
    maximum_fee: number | null;
  },
) {
  const fee = integer(p.fixed_fee + ratio(subtotal, p.basis_points, 10000));
  return Math.min(
    p.maximum_fee ?? Number.MAX_SAFE_INTEGER,
    Math.max(p.minimum_fee, fee),
  );
}
export function money(pence: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(pence / 100);
}
export function weekStart(date = new Date()) {
  const day = (date.getUTCDay() + 6) % 7;
  const d = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() - day,
    ),
  );
  return d.toISOString().slice(0, 10);
}
