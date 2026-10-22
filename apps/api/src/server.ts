import { createApp } from "./app";
import { config } from "../../../packages/config/src/index";
import { connect } from "../../../packages/database/src/index";
const env = config();
const db = connect(env.DATABASE_URL);
const app = await createApp(db);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
await app.listen({ host: "0.0.0.0", port: env.PORT });
