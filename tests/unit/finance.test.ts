import { describe, it, expect } from "vitest";
import {
  canTransition,
  partnerFee,
  ratio,
  weekStart,
} from "../../packages/shared/src/index";
describe("financial arithmetic", () => {
  it("fixed launch fee and bounded basis-point commission", () => {
    expect(
      partnerFee(1000, {
        fixed_fee: 100,
        basis_points: 0,
        minimum_fee: 0,
        maximum_fee: null,
      }),
    ).toBe(100);
    expect(
      partnerFee(999, {
        fixed_fee: 0,
        basis_points: 1250,
        minimum_fee: 50,
        maximum_fee: 100,
      }),
    ).toBe(100);
  });
  it("rounds integer minor units consistently", () => {
    expect(ratio(100, 1, 3)).toBe(33);
    expect(ratio(100, 2, 3)).toBe(67);
    expect(ratio(-101, 5000, 10000)).toBe(-51);
  });
  it("cumulative reversals sum exactly to the original fee", () => {
    const a = ratio(100, 333, 1000);
    const b = ratio(100, 666, 1000) - a;
    const c = 100 - a - b;
    expect(a + b + c).toBe(100);
  });
  it("rejects unsafe arithmetic", () => {
    expect(() => ratio(Number.MAX_SAFE_INTEGER + 1, 1, 2)).toThrow();
  });
  it("uses UTC Monday billing boundaries", () => {
    expect(weekStart(new Date("2026-10-25T23:59:59Z"))).toBe("2026-10-19");
  });
});
describe("order state machine", () => {
  it("rejects jumps, repeated completion and wrong fulfilment", () => {
    expect(
      canTransition("awaiting_acceptance", "completed", "collection"),
    ).toBe(false);
    expect(canTransition("completed", "completed", "collection")).toBe(false);
    expect(canTransition("preparing", "out_for_delivery", "collection")).toBe(
      false,
    );
    expect(canTransition("preparing", "ready", "collection")).toBe(true);
  });
});
