import { z } from "zod";
export const id = z.uuid();
export const policyInput = z
  .object({
    fixedFee: z.number().int().min(0).max(10000),
    basisPoints: z.number().int().min(0).max(10000).default(0),
    minimumFee: z.number().int().min(0).default(0),
    maximumFee: z.number().int().min(0).nullable().default(null),
    serviceFee: z.number().int().min(0).max(10000),
    subscriptionFee: z.number().int().min(0).default(0),
    vatBasisPoints: z.number().int().min(0).max(10000),
    taxConfirmed: z.boolean(),
    effectiveAt: z.iso.datetime().optional(),
  })
  .refine(
    (p) => p.maximumFee === null || p.maximumFee >= p.minimumFee,
    "maximum below minimum",
  );
export const checkoutInput = z.object({
  partnerId: id,
  items: z
    .array(
      z.object({ productId: id, quantity: z.number().int().min(1).max(50) }),
    )
    .min(1)
    .max(50),
  customerName: z.string().trim().min(2).max(100),
  customerEmail: z.email().max(254),
  fulfilment: z.enum(["collection", "delivery"]),
  paymentMethod: z.enum(["cash", "card"]),
  address: z
    .object({
      line1: z.string().min(3).max(150),
      postcode: z.string().min(5).max(10),
    })
    .optional(),
  scheduledAt: z.iso.datetime().optional(),
});
