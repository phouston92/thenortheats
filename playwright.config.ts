import { defineConfig } from "@playwright/test";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error(
    "Browser tests require a dedicated TEST_DATABASE_URL ending _test",
  );
const env = {
  ...process.env,
  DATABASE_URL: url,
  REDIS_URL: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  NODE_ENV: "test",
  ADMIN_MFA_SECRET: "JBSWY3DPEHPK3PXP",
  DEV_MAIL_DIR: "/tmp/north-browser-mail",
};
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://localhost:3000",
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
  },
  webServer: [
    {
      command: "pnpm dev:api",
      url: "http://localhost:3001/api/ready",
      env,
      reuseExistingServer: false,
    },
    {
      command: "pnpm dev:web",
      url: "http://localhost:3000",
      env,
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: "pnpm dev:partner",
      url: "http://localhost:5174",
      env,
      reuseExistingServer: false,
    },
    {
      command: "pnpm dev:admin",
      url: "http://localhost:5173",
      env,
      reuseExistingServer: false,
    },
    {
      command:
        "CI=1 EXPO_OFFLINE=1 EXPO_NO_TELEMETRY=1 pnpm dev:mobile --web --port 8081",
      url: "http://localhost:8081",
      env,
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
  reporter: [["list"], ["html", { open: "never" }]],
});
