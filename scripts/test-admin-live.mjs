// Operator-only production check. Credentials stay in memory. Only the uniquely
// labelled work created by this run is modified and cleaned up.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { chromium, expect } from "@playwright/test";

const site = "https://awerkori.github.io/project-nox-scan-staff/";
const ref = "pgumtergvtbeepzpgvkv";
const url = `https://${ref}.supabase.co`;
const owner = "46dce535-621d-43de-99d4-1aef047e08d5";
const title = `VALIDAÇÃO UX — ${Date.now()}`;
const result = JSON.parse(execFileSync("npx", ["--yes", "supabase", "projects", "api-keys", "--project-ref", ref, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const keys = Array.isArray(result) ? result : result.api_keys;
const auth = { persistSession: false, autoRefreshToken: false };
const backend = createClient(url, keys.find(k => k.name === "service_role").api_key, { auth });
const staff = createClient(url, keys.find(k => k.name === "anon").api_key, { auth });
const checked = response => { if (response.error) throw new Error(`Supabase operation failed (${response.error.code || response.error.status || "unknown"})`); return response.data; };
let work, chapter, browser;
try {
  const user = checked(await backend.auth.admin.getUserById(owner)).user;
  const member = checked(await backend.from("staff_members").select("is_admin,is_active").eq("user_id", owner).single());
  assert.ok(member.is_active && member.is_admin);
  const link = checked(await backend.auth.admin.generateLink({ type: "magiclink", email: user.email }));
  const login = checked(await staff.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "magiclink" }));
  assert.equal(login.user.id, owner);
  work = checked(await staff.from("works").insert({ title, synopsis: "Validação de interface. Removida ao terminar este teste." }).select("id").single());
  checked(await staff.rpc("add_catalog_chapter_range", { p_work_id: work.id, p_start: 1, p_end: 1 }));
  const catalog = checked(await staff.from("work_chapter_catalog").select("id").eq("work_id", work.id).single());
  chapter = checked(await staff.rpc("start_catalog_production", { p_catalog_id: catalog.id }));
  const raw = checked(await staff.from("chapter_stages").select("id").eq("chapter_id", chapter.id).eq("stage", "RAW").single());
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addInitScript(session => localStorage.setItem(`sb-pgumtergvtbeepzpgvkv-auth-token`, JSON.stringify(session)), login.session);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", () => errors.push("pageerror"));
  page.on("console", message => { if (message.type() === "error") errors.push("console-error"); });
  await mkdir("test-results", { recursive: true });
  for (const [width, height, label] of [[2560,1440,"1440p"], [1920,1080,"1080p"], [1280,720,"notebook"], [820,1180,"tablet"], [390,844,"mobile"]]) {
    await page.setViewportSize({ width, height });
    for (const route of ["", "raw", "clean-redraw", "translation", "typeset", "review", "ready", "published", "works", `works/${work.id}`, "notifications", "admin/members", "admin/settings", `chapters/${chapter.id}`]) {
      // A different query forces a document navigation. Hash-only navigation
      // can otherwise capture the preceding screen before async data settles.
      await page.goto(`${site}?ux-check=${label}-${encodeURIComponent(route)}#/${route}`, { waitUntil: "networkidle" });
      await expect(route === "admin/settings" ? page.getByRole("heading", { name: "Configurações", exact: true }) : page.locator(".page-heading h2")).toBeVisible({ timeout: 30000 });
      await expect(page.getByText(/^Carregando/)).toHaveCount(0, { timeout: 30000 });
      if (route === `works/${work.id}`) {
        await expect(page.getByLabel("Título", { exact: true })).toHaveValue(title);
        await expect(page.getByRole("textbox", { name: "Sinopse", exact: true })).toHaveValue("Validação de interface. Removida ao terminar este teste.");
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Overflow ${label}/${route}`);
      await page.screenshot({ path: `test-results/live-${label}-${route.replaceAll("/", "-") || "home"}.png`, fullPage: true });
    }
    console.log(`PASS: production routes and overflow checks — ${label}`);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${site}#/chapters/${chapter.id}`, { waitUntil: "networkidle" });
  const manage = page.locator(".chapter-administration");
  await manage.locator("summary").first().click();
  await page.getByLabel("Etapa para atribuir").selectOption(raw.id);
  await page.getByRole("button", { name: "Salvar responsável" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirmar alteração" }).click();
  await expect(page.getByText("Tarefa devolvida à fila.", { exact: true })).toBeVisible();
  await page.getByLabel("Etapa para atribuir").selectOption(raw.id);
  await page.getByLabel("Novo responsável").selectOption(owner);
  await page.getByRole("button", { name: "Salvar responsável" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirmar alteração" }).click();
  await expect(page.getByText("Responsável atualizado.", { exact: true })).toBeVisible();
  await page.getByLabel("Etapa para reabrir").selectOption(raw.id);
  await page.getByLabel("Motivo da reabertura").fill("Validação autorizada de interface");
  await page.getByRole("button", { name: "Reabrir etapa", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reabrir etapa", exact: true }).click();
  await expect(page.getByText("Etapa reaberta. O andamento foi atualizado.")).toBeVisible();
  await page.goto(`${site}#/notifications`, { waitUntil: "networkidle" });
  const notice = page.locator(".notification").filter({ hasText: title });
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Marcar como lida" }).click();
  await expect(notice).toHaveCount(0);
  await page.goto(`${site}#/chapters/${chapter.id}`, { waitUntil: "networkidle" });
  await manage.locator("summary").first().click();
  await page.getByRole("button", { name: "Cancelar produção", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancelar produção", exact: true }).click();
  await expect(page.locator(".chapter-state")).toHaveText("Produção cancelada");
  assert.equal(checked(await staff.from("work_chapter_catalog").select("status").eq("id", catalog.id).single()).status, "TODO");
  assert.equal(checked(await staff.from("notifications").select("id").eq("chapter_id", chapter.id)).length, 0);
  await page.getByRole("button", { name: "Excluir capítulo", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Excluir capítulo" })).toBeDisabled();
  await page.getByLabel("Confirmação da exclusão").fill(`${title} #1`);
  await page.getByRole("dialog").getByRole("button", { name: "Excluir capítulo", exact: true }).click();
  await page.waitForURL("**/#/works");
  assert.equal(checked(await staff.from("chapters").select("id").eq("id", chapter.id)).length, 0);
  assert.deepEqual(errors, []);
  console.log("PASS: real deployed UI — release, assignment, reopen, cancel, pending-notification cleanup, typed deletion and clean console. No existing staff work modified.");
} finally {
  await browser?.close();
  if (chapter) {
    const remaining = checked(await staff.from("chapters").select("id").eq("id", chapter.id).maybeSingle());
    if (remaining) checked(await staff.rpc("admin_delete_chapter", { p_chapter_id: chapter.id, p_confirmation: `${title} #1` }));
  }
  if (work) checked(await staff.from("works").delete().eq("id", work.id).eq("title", title));
  console.log("Temporary validation work cleaned up; no stored files were created or removed.");
}
