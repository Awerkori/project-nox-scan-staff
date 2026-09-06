// Read-only checks of the deployed site and unauthenticated API access.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const site = "https://awerkori.github.io/project-nox-scan-staff/";
const vars = JSON.parse(
  execFileSync("gh", ["variable", "list", "--json", "name,value"], {
    encoding: "utf8",
  }),
);
const value = (name) => vars.find((item) => item.name === name)?.value;
const url = value("VITE_SUPABASE_URL"),
  key = value("VITE_SUPABASE_ANON_KEY");
assert.ok(url && key);
for (const table of [
  "works",
  "chapters",
  "artifacts",
  "staff_members",
  "staff_invites",
  "stage_completions",
  "notifications",
  "production_email_settings",
  "production_email_outbox",
]) {
  const response = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
    headers: { apikey: key },
  });
  assert.ok(
    response.status === 401 ||
      response.status === 403 ||
      (response.ok && (await response.json()).length === 0),
    `${table}: private data exposed`,
  );
}
const blocked = await fetch(`${url}/rest/v1/rpc/claim_stage`, {
  method: "POST",
  headers: { apikey: key, "Content-Type": "application/json" },
  body: JSON.stringify({ p_stage_id: "00000000-0000-0000-0000-000000000000" }),
});
assert.ok(blocked.status >= 400, "Anonymous stage claim accepted");
const browser = await chromium.launch({ headless: true });
await mkdir("test-results", { recursive: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  for (const [width, height, label] of [
    [1440, 960, "desktop"],
    [1280, 720, "notebook"],
    [390, 844, "mobile"],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(site, { waitUntil: "networkidle" });
    await expect(
      page.getByRole("button", { name: "Entrar com GitHub" }),
    ).toBeVisible();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page.screenshot({
      path: `test-results/production-login-${label}.png`,
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  await page.getByRole("button", { name: "Entrar com GitHub" }).click();
  await page.waitForURL((u) => u.hostname === "github.com", { timeout: 20000 });
  console.log(
    "PASS: production login screen (desktop/notebook/mobile), clean console, GitHub redirect and anonymous API denial. External identity login still requires the account owner.",
  );
} finally {
  await browser.close();
}
