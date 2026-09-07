// Isolated PostgreSQL only. Telegram acknowledgements below are explicit fixtures,
// not evidence of a real Telegram upload; that needs the deployed provider test.
import assert from "node:assert/strict";
import { as, sql, pool, users, start, stage, database } from "./database.mjs";
let checks = 0;
const ok = (value) => { assert.ok(value); checks++; };
const denied = async (action) => { await assert.rejects(action); checks++; };
const hash = "a".repeat(64);
try {
  await denied(as(users.raw, "update artifact_storage_settings set telegram_enabled=true"));
  await denied(as(users.outsider, "select artifact_upload_configuration()"));
  await sql("update artifact_storage_settings set telegram_enabled=true,bridge_url='https://nox-test.example.workers.dev'");
  const chapter = await start();
  const artifact = (await as(users.raw, "select to_jsonb(reserve_artifact_upload($1,'RAW','original.zip','application/zip',8388612,null)) a", [chapter.id])).rows[0].a;
  ok(artifact.provider === "telegram");
  ok((await as(users.raw, "select artifact_upload_configuration() c")).rows[0].c.provider === "telegram");
  await denied(as(users.translator, "select begin_telegram_artifact_part($1,0,$2)", [artifact.id, hash]));
  await denied(as(users.raw, "select begin_telegram_artifact_part($1,2,$2)", [artifact.id, hash]));
  await denied(as(users.raw, "select begin_telegram_artifact_part($1,0,'bad')", [artifact.id]));
  const race = await Promise.allSettled([0, 1].map(() => as(users.raw, "select begin_telegram_artifact_part($1,0,$2) p", [artifact.id, hash])));
  ok(race.filter((r) => r.status === "fulfilled").length === 1);
  const part = race.find((r) => r.status === "fulfilled").value.rows[0].p;
  const confirm = "select confirm_telegram_artifact_part($1,0,$2,'file-one',42,'-100123',8388608,$3)";
  await denied(as(users.raw, confirm, [artifact.id, part.lease_id, hash]));
  await denied(as(users.admin, confirm, [artifact.id, part.lease_id, hash]));
  await denied(as(users.raw, "select * from telegram_artifact_parts"));
  await denied(as(users.raw, "select finalize_artifact_upload($1)", [artifact.id]));
  await sql(confirm, [artifact.id, part.lease_id, hash]);
  await sql(confirm, [artifact.id, part.lease_id, hash]);
  ok((await as(users.raw, "select begin_telegram_artifact_part($1,0,$2) p", [artifact.id, hash])).rows[0].p.stored);
  await denied(as(users.raw, "select finalize_artifact_upload($1)", [artifact.id]));
  const last = (await as(users.raw, "select begin_telegram_artifact_part($1,1,$2) p", [artifact.id, hash])).rows[0].p;
  ok(last.byte_size === 4);
  await sql("select confirm_telegram_artifact_part($1,1,$2,'file-two',43,'-100123',4,$3)", [artifact.id, last.lease_id, hash]);
  const finalized = (await as(users.raw, "select to_jsonb(finalize_artifact_upload($1)) a", [artifact.id])).rows[0].a;
  ok(finalized.upload_status === "AVAILABLE" && finalized.is_current);
  const manifest = (await as(users.clean, "select telegram_download_manifest($1) m", [artifact.provider_key])).rows[0].m;
  ok(manifest.parts.length === 2 && manifest.name === "original.zip");
  ok(!JSON.stringify(manifest).includes("file-one") && !JSON.stringify(manifest).includes("-100123"));
  await denied(as(users.outsider, "select telegram_download_manifest($1)", [artifact.provider_key]));
  await as(users.raw, "select complete_stage($1)", [(await stage(chapter, "RAW")).id]);
  ok((await stage(chapter, "CLEAN_REDRAW")).status === "AVAILABLE");
  console.log(`PASS: ${checks} Telegram metadata/permission assertions in ${database}; provider acknowledgements simulated.`);
} finally { await pool.end(); }
