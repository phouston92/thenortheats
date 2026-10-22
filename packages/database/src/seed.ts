import { connect, type Database } from "./index";
import { fileURLToPath } from "node:url";
export async function seed(db: Database) {
  await db.begin(async (tx) => {
    for (const name of ["Lancaster", "Morecambe", "Kendal", "Preston"])
      await tx`INSERT INTO towns(name) VALUES(${name}) ON CONFLICT DO NOTHING`;
    if (process.env.SEED_ADMIN_EMAIL)
      await tx`INSERT INTO users(email,role) VALUES(${process.env.SEED_ADMIN_EMAIL.toLowerCase()},'admin') ON CONFLICT DO NOTHING`;
    // Demo partners deliberately pending: activation requires an explicit policy, never a global default.
    for (const [id, name, town] of [
      ["10000000-0000-4000-8000-000000000001", "Ember & Stone", "Lancaster"],
      ["10000000-0000-4000-8000-000000000002", "The Bay Kitchen", "Morecambe"],
    ]) {
      await tx`INSERT INTO partners(id,name,town_id,delivery_postcodes) SELECT ${id},${name},id,ARRAY['LA1','LA4'] FROM towns WHERE name=${town} ON CONFLICT DO NOTHING`;
      for (const [pid, title, price, category] of [
        [id.slice(0, -1) + "3", "Margherita", 950, "Wood-fired pizza"],
        [id.slice(0, -1) + "4", "Smoky house burger", 1150, "From the grill"],
        [id.slice(0, -1) + "5", "Sea salt fries", 350, "Sides"],
      ] as const)
        await tx`INSERT INTO products(id,partner_id,name,price,category,allergens) VALUES(${id.endsWith("2") ? "10000001" + pid.slice(8) : pid},${id},${title},${price},${category},ARRAY['Ask partner before ordering']) ON CONFLICT DO NOTHING`;
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = connect();
  try {
    await seed(db);
    console.log("Development seed loaded; partners remain pending");
  } finally {
    await db.end();
  }
}
