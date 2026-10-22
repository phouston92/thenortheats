import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
export const towns = pgTable("towns", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull().unique(),
  active: boolean().notNull().default(true),
});
export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  role: text().notNull(),
  disabled: boolean().notNull().default(false),
});
export const partners = pgTable("partners", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  townId: uuid("town_id")
    .notNull()
    .references(() => towns.id),
  status: text().notNull().default("pending"),
  paused: boolean().notNull().default(false),
});
export const products = pgTable("products", {
  id: uuid().primaryKey().defaultRandom(),
  partnerId: uuid("partner_id")
    .notNull()
    .references(() => partners.id),
  name: text().notNull(),
  category: text().notNull(),
  description: text().notNull(),
  price: integer().notNull(),
  available: boolean().notNull(),
});
export const orders = pgTable("orders", {
  id: uuid().primaryKey().defaultRandom(),
  partnerId: uuid("partner_id")
    .notNull()
    .references(() => partners.id),
  status: text().notNull(),
  total: integer().notNull(),
  pricingSnapshot: jsonb("pricing_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
// SQL migrations are authoritative for constraints/triggers. Remaining models are pending.
