import { tmpdir } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import { TOTP, Secret } from "otpauth";
if (process.env.NODE_ENV !== "development")
  throw new Error("Private development helper only");
if (process.argv[2] === "mfa") {
  if (!process.env.ADMIN_MFA_SECRET)
    throw new Error("ADMIN_MFA_SECRET required");
  console.log(
    new TOTP({
      secret: Secret.fromBase32(process.env.ADMIN_MFA_SECRET),
    }).generate(),
  );
} else {
  const dir =
    process.env.DEV_MAIL_DIR ||
    `${tmpdir()}/north-mail-${process.getuid?.() ?? "dev"}`;
  const files = await readdir(dir);
  const messages = await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => JSON.parse(await readFile(`${dir}/${f}`, "utf8"))),
  );
  for (const m of messages)
    console.log(`${m.email} | challenge ${m.challengeId} | code ${m.code}`);
}
