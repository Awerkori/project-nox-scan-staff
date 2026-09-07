// Explicit operator integration test. Creates only a clearly labelled test work;
// never deletes staff data. Secrets and the owner's test session stay in memory.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const url = "https://pgumtergvtbeepzpgvkv.supabase.co";
const bridge = "https://nox-staff-artifacts.project-nox-awerkori.workers.dev";
const owner = "46dce535-621d-43de-99d4-1aef047e08d5";
const title = "TESTE TÉCNICO — Telegram Storage";
const rawKeys = JSON.parse(execFileSync("npx", ["--yes", "supabase", "projects", "api-keys", "--project-ref", "pgumtergvtbeepzpgvkv", "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const keys = Array.isArray(rawKeys) ? rawKeys : rawKeys.api_keys;
const serviceKey = keys.find(k => k.name === "service_role").api_key;
const anonKey = keys.find(k => k.name === "anon").api_key;
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const staff = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const checked = (result) => { if (result.error) throw new Error(`Supabase operation failed (${result.error.code || result.error.status || "unknown"})`); return result.data; };
try {
  const user = checked(await admin.auth.admin.getUserById(owner)).user;
  const member = checked(await admin.from("staff_members").select("is_admin,is_active").eq("user_id", owner).single());
  assert.ok(member.is_active && member.is_admin);
  const link = checked(await admin.auth.admin.generateLink({ type: "magiclink", email: user.email }));
  const login = checked(await staff.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "magiclink" }));
  assert.equal(login.user.id, owner);
  const health = await fetch(`${bridge}/health`);
  assert.equal((await health.json()).ready, true);
  let work = checked(await staff.from("works").select("id").eq("title", title).maybeSingle());
  if (!work) work = checked(await staff.from("works").insert({ title, synopsis: "Arquivo de validação da integração. Não faz parte da produção editorial." }).select("id").single());
  checked(await staff.rpc("add_catalog_chapter_range", { p_work_id: work.id, p_start: 1, p_end: 1 }));
  const catalog = checked(await staff.from("work_chapter_catalog").select("id").eq("work_id", work.id).eq("number", 1).single());
  let chapter = checked(await staff.from("chapters").select("id").eq("catalog_id", catalog.id).maybeSingle());
  if (!chapter) chapter = checked(await staff.rpc("start_catalog_production", { p_catalog_id: catalog.id }));
  if (process.argv[2] === "browser") {
    const deployed = await (await fetch("https://awerkori.github.io/project-nox-scan-staff/")).text();
    const entry = deployed.match(/src="([^"]+\/index-[^"]+\.js)"/);
    assert.ok(entry, "Production application bundle not found");
    const bundle = await (await fetch(new URL(entry[1], "https://awerkori.github.io"))).text();
    assert.ok(bundle.includes("telegram_download_manifest"), "Telegram-compatible frontend must be deployed first");
    checked(await admin.from("artifact_storage_settings").update({ telegram_enabled: true, bridge_url: bridge }).eq("id", true));
    const configuration = checked(await staff.rpc("artifact_upload_configuration"));
    assert.equal(configuration.provider, "telegram", "Deploy the frontend before enabling the Telegram provider");
    await mkdir("test-results", { recursive: true });
    const name = `validacao-telegram-200MiB-${Date.now()}.bin`;
    const original = randomBytes(200 * 1024 * 1024);
    const digest = createHash("sha256").update(original).digest("hex");
    await writeFile(`test-results/${name}`, original);
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
      await context.addInitScript(session => localStorage.setItem("sb-pgumtergvtbeepzpgvkv-auth-token", JSON.stringify(session)), login.session);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", () => errors.push("pageerror"));
      let sent = 0;
      page.on("response", response => {
        if (response.url().startsWith(bridge) && response.request().method() === "POST") {
          if (response.status() === 200) console.log(`Browser uploaded part ${++sent}/25`);
          else console.log("Browser transfer HTTP:", response.status());
        }
      });
      await page.goto(`https://awerkori.github.io/project-nox-scan-staff/#/chapters/${chapter.id}`, { waitUntil: "networkidle" });
      await expect(page.getByRole("button", { name: "Fazer upload", exact: true })).toBeVisible({ timeout: 30000 });
      await page.getByLabel("Arquivo RAW", { exact: true }).setInputFiles(`test-results/${name}`);
      await expect(page.getByRole("button", { name: /Enviando/ })).toBeVisible();
      await page.screenshot({ path: "test-results/telegram-live-upload.png", fullPage: true });
      await expect(page.getByText("Arquivo enviado. Agora você já pode concluir a etapa.", { exact: true })).toBeVisible({ timeout: 1200000 });
      const artifact = checked(await staff.from("artifacts").select("id,provider,provider_key,upload_status,byte_size,version").eq("chapter_id", chapter.id).eq("original_name", name).single());
      assert.equal(artifact.provider, "telegram");
      assert.equal(artifact.upload_status, "AVAILABLE");
      assert.equal(artifact.byte_size, original.length);
      const parts = checked(await admin.from("telegram_artifact_parts").select("state,telegram_chat_id,byte_size").eq("artifact_id", artifact.id));
      assert.equal(parts.length, 25);
      assert.ok(parts.every(p => p.state === "STORED" && p.telegram_chat_id === "-1004440522630"));
      console.log("Browser upload complete; Supabase confirms all 25 parts in STAFF SCAN.");
      const downloadEvent = page.waitForEvent("download", { timeout: 1200000 });
      await page.locator(".uploaded-file").click();
      await expect(page.getByRole("status", { name: "" }).filter({ hasText: "Baixando" })).toBeVisible();
      const download = await downloadEvent;
      assert.equal(download.suggestedFilename(), name);
      const recoveredPath = "test-results/telegram-live-200MiB-downloaded.bin";
      await download.saveAs(recoveredPath);
      const recovered = await readFile(recoveredPath);
      assert.equal(recovered.length, original.length);
      assert.equal(createHash("sha256").update(recovered).digest("hex"), digest);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: "test-results/telegram-live-complete.png", fullPage: true });
      const anonymous = await fetch(`${bridge}/files/${artifact.provider_key}/parts/0`);
      assert.equal(anonymous.status, 401);
      const directConfirm = await staff.rpc("confirm_telegram_artifact_part", { p_artifact_id: artifact.id, p_part_index: 0, p_lease_id: artifact.id, p_file_id: "forged", p_message_id: 1, p_chat_id: "-1", p_byte_size: 8388608, p_sha256: digest });
      assert.ok(directConfirm.error, "Even a staff administrator cannot forge Telegram storage acknowledgements");
      console.log("PASS: production browser uploaded and downloaded 200 MiB, exact filename and SHA-256; private channel, real metadata, anonymous denial and forged confirmation denial. No OAuth login claim: an owner-authorized test session was used.");
    } finally { await browser.close(); }
  } else {
  const bytes = randomBytes(8388608);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const artifact = checked(await staff.rpc("reserve_artifact_upload", { p_chapter_id: chapter.id, p_stage: "RAW", p_original_name: "validacao-telegram-8MiB.bin", p_mime_type: "application/octet-stream", p_byte_size: bytes.length }));
  // Provider remains disabled globally until the frontend is deployed and tested.
  // Only this test-owned reservation is opted in for the preflight.
  const changed = checked(await admin.from("artifacts").update({ provider: "telegram", provider_key: artifact.id }).eq("id", artifact.id).eq("uploaded_by", owner).eq("upload_status", "PENDING").select("id"));
  assert.equal(changed.length, 1);
  const headers = { Authorization: `Bearer ${login.session.access_token}`, "Content-Type": "application/octet-stream", "X-Part-SHA256": sha };
  const upload = await fetch(`${bridge}/files/${artifact.id}/parts/0`, { method: "POST", body: bytes, headers });
  console.log("Live 8 MiB upload HTTP:", upload.status);
  assert.equal(upload.status, 200, "Worker upload failed; inspect sanitized worker logs");
  checked(await staff.rpc("finalize_artifact_upload", { p_artifact_id: artifact.id }));
  const download = await fetch(`${bridge}/files/${artifact.id}/parts/0`, { headers: { Authorization: headers.Authorization } });
  console.log("Live 8 MiB download HTTP:", download.status);
  assert.equal(download.status, 200);
  const recovered = Buffer.from(await download.arrayBuffer());
  assert.equal(recovered.length, bytes.length);
  assert.equal(createHash("sha256").update(recovered).digest("hex"), sha);
  const parts = checked(await admin.from("telegram_artifact_parts").select("telegram_chat_id,state,byte_size").eq("artifact_id", artifact.id));
  assert.equal(parts[0].telegram_chat_id, "-1004440522630");
  assert.equal(parts[0].state, "STORED");
  console.log("PASS: real 8 MiB round trip, STAFF SCAN channel, metadata and SHA-256. Test chapter:", chapter.id);
  }
} catch (error) {
  // Never print API responses, sessions, generated links or fetch URL errors.
  console.error(error instanceof assert.AssertionError ? error.message : "Live test failed; credentials and upstream responses suppressed.");
  process.exitCode = 1;
}
