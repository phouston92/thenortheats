import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { TOTP, Secret } from "otpauth";
import { connect } from "../../packages/database/src/index";
import { encryptMfa } from "../../apps/api/src/mfa";
process.env.MFA_ENCRYPTION_KEY = "42".repeat(32);
import { migrate } from "../../packages/database/src/migrate";
const db = connect(process.env.TEST_DATABASE_URL);
const partnerId = "20000000-0000-4000-8000-000000000001";
test.beforeAll(async () => {
  await migrate(db);
  await db.begin(async (tx) => {
    const [town] =
      await tx`INSERT INTO towns(name) VALUES('Browser Test Town') ON CONFLICT(name) DO UPDATE SET active=true RETURNING id`;
    const [admin] =
      await tx`INSERT INTO users(email,role) VALUES('browser-admin@example.test','admin') ON CONFLICT(email) DO UPDATE SET role='admin' RETURNING id`;
    await tx`INSERT INTO partners(id,name,town_id) VALUES(${partnerId},'Browser Test Kitchen',${town.id}) ON CONFLICT(id) DO UPDATE SET paused=false`;
    if (
      !(await tx`SELECT id FROM fee_policies WHERE partner_id=${partnerId}`)
        .length
    )
      await tx`INSERT INTO fee_policies(partner_id,fixed_fee,service_fee,vat_basis_points,approved_by) VALUES(${partnerId},100,100,0,${admin.id})`;
    await tx`UPDATE partners SET status='active' WHERE id=${partnerId}`;
    await tx`INSERT INTO products(id,partner_id,name,category,price,allergens) VALUES('20000000-0000-4000-8000-000000000003',${partnerId},'Test Margherita','Pizza',950,ARRAY['milk','wheat']) ON CONFLICT(id) DO UPDATE SET available=true`;
    const [owner] =
      await tx`INSERT INTO users(email,role) VALUES('browser-owner@example.test','owner') ON CONFLICT(email) DO UPDATE SET role='owner' RETURNING id`;
    await tx`INSERT INTO admin_mfa(user_id,secret_ciphertext) VALUES(${admin.id},${encryptMfa("JBSWY3DPEHPK3PXP", admin.id)}) ON CONFLICT(user_id) DO UPDATE SET secret_ciphertext=EXCLUDED.secret_ciphertext`;
    await tx`DELETE FROM mfa_uses WHERE user_id=${admin.id}`;
    await tx`INSERT INTO memberships VALUES(${owner.id},${partnerId}) ON CONFLICT DO NOTHING`;
  });
});
test.afterAll(async () => {
  await db.end();
});
async function login(page: Page, url: string, email: string, admin = false) {
  await page.goto(url);
  await page.getByLabel("Email address", { exact: true }).fill(email);
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/api/auth/request"),
  );
  await page.getByRole("button", { name: "Email me a code" }).click();
  const challenge = await (await response).json();
  const mail = JSON.parse(
    await readFile(
      `/tmp/north-browser-mail/${challenge.challengeId}.json`,
      "utf8",
    ),
  );
  await page.getByLabel("Verification code", { exact: true }).fill(mail.code);
  if (admin)
    await page
      .getByLabel("Authenticator code (administrators)")
      .fill(
        new TOTP({ secret: Secret.fromBase32("JBSWY3DPEHPK3PXP") }).generate(),
      );
  await page.getByRole("button", { name: "Verify and sign in" }).click();
}
test("administrator signs in with MFA, reviews live dashboard and adds pending partner", async ({
  page,
}) => {
  await login(
    page,
    "http://localhost:5273",
    "browser-admin@example.test",
    true,
  );
  await expect(
    page.getByRole("heading", { name: "Platform overview" }),
  ).toBeVisible();
  await expect(page.getByText("Loading live platform data…")).not.toBeVisible();
  await page.screenshot({
    path: "test-results/platform-admin.png",
    fullPage: true,
  });
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
  await page.getByRole("button", { name: "Add partner", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("New Kitchen " + Date.now());
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Changes saved.");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Toggle navigation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await expect(
    page.getByRole("navigation", { name: "Administration" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("customer cash checkout → partner completion → customer tracking uses real API", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Where are we eating?")
    .selectOption("Browser Test Town");
  await page.getByRole("button", { name: "Explore menu" }).click();
  await page
    .getByRole("button", { name: "Add Test Margherita", exact: true })
    .click();
  await expect(
    page.getByText("Customer service fee", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review checkout" }).click();
  await expect(
    page.getByRole("option", { name: "Card · Stripe test mode (unavailable)" }),
  ).toHaveJSProperty("disabled", true);
  await page.getByLabel("Full name").fill("Browser Customer");
  await page
    .getByLabel("Email address", { exact: true })
    .fill("browser-customer@example.test");
  await page.getByRole("checkbox").check();
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/orders") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Place order" }).click();
  const created = await (await response).json();
  await expect(
    page.getByRole("heading", { name: "We’ve got your order." }),
  ).toBeVisible();
  await expect(
    page.getByText("awaiting acceptance", { exact: true }).first(),
  ).toBeVisible();
  const context = await browser.newContext();
  const partner = await context.newPage();
  await login(partner, "http://localhost:5274", "browser-owner@example.test");
  await expect(
    partner.getByRole("heading", { name: "Orders", exact: true }),
  ).toBeVisible();
  const row = partner
    .getByRole("row")
    .filter({ hasText: "#" + created.id.slice(0, 8) });
  for (const label of [
    "Accept",
    "Start preparing",
    "Ready for collection",
    "Complete",
  ]) {
    await row.getByRole("button", { name: label, exact: true }).click();
  }
  await expect(row.getByText("completed", { exact: true })).toBeVisible();
  await expect(
    page.getByText("completed", { exact: true }).first(),
  ).toBeVisible({ timeout: 10000 });
  const [sum] =
    await db`SELECT sum(amount)::int AS amount FROM ledger_entries WHERE order_id=${created.id}`;
  expect(sum.amount).toBe(200);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    (
      await new AxeBuilder({ page: partner })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await context.close();
});
test("customer homepage works at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your town." })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});

test("Expo Web foundation loads API discovery and a basket", async ({
  page,
}) => {
  await page.goto("http://localhost:8081");
  await expect(
    page.getByText("Your town. Your next favourite.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Browser Test Town", exact: true })
    .click();
  await page.getByRole("button", { name: "Explore menu" }).click();
  await expect(
    page.getByText("Test Margherita", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add to basket" }).click();
  await page.getByRole("button", { name: "basket", exact: true }).click();
  await expect(
    page.getByText("1 × Test Margherita · £9.50", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Customer service fee: £1.00", { exact: true }),
  ).toBeVisible();
});
