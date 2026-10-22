import { z } from "zod";
const hex = z.string().regex(/^[a-f0-9]{64}$/i);
export function mfaKeys(env = process.env) {
  const legacy = env.MFA_ENCRYPTION_KEY
    ? hex.parse(env.MFA_ENCRYPTION_KEY)
    : undefined;
  let keys: Record<string, string> = {};
  try {
    if (env.MFA_ENCRYPTION_KEYS)
      keys = z
        .record(z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/), hex)
        .parse(JSON.parse(env.MFA_ENCRYPTION_KEYS));
  } catch {
    throw new Error("Invalid MFA keyring configuration");
  }
  const active = env.MFA_ACTIVE_KEY_ID;
  if (active && !keys[active])
    throw new Error("Active MFA key is missing from keyring");
  if (!active && !legacy) throw new Error("MFA encryption key required");
  return { legacy, keys, active };
}
