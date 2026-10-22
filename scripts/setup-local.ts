import { tmpdir } from "node:os";
import { writeFile, mkdir } from "node:fs/promises";
import { Secret } from "otpauth";
if (process.env.NODE_ENV === "production")
  throw new Error("Development setup only");
await mkdir(`${tmpdir()}/north-mail-${process.getuid?.() ?? "dev"}`, {
  recursive: true,
  mode: 0o700,
});
try {
  await writeFile(
    ".env",
    `NODE_ENV=development
DATABASE_URL=postgres://north:north_dev_only@127.0.0.1:5432/north_dev
REDIS_URL=redis://127.0.0.1:6379
SEED_ADMIN_EMAIL=admin@example.test
ADMIN_MFA_SECRET=${new Secret({ size: 20 }).base32}
`,
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    "Private local .env created. Use the development mailbox and authenticator helper to sign in.",
  );
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === "EEXIST")
    console.log("Existing .env preserved");
  else throw e;
}
