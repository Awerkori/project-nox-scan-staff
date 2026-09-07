// Real isolated PostgreSQL, including RLS and concurrent admin/member operations.
import assert from "node:assert/strict";
import { as, sql, pool, users, start, stage, finish, upload, database, workId } from "./database.mjs";
let checks = 0;
const ok = value => { assert.ok(value); checks++; };
const denied = async action => { await assert.rejects(action); checks++; };
const notices = (user, chapter) => as(user, "select * from notifications where chapter_id=$1 and read_at is null and archived_at is null", [chapter.id]);
try {
  const c = await start(20);
  const raw = await stage(c, "RAW");
  for (const name of ["raw", "translator", "outsider"]) {
    await denied(as(users[name], "select admin_cancel_production($1)", [c.id]));
    await denied(as(users[name], "select admin_assign_stage($1,$2)", [raw.id, users.raw2]));
    await denied(as(users[name], "select admin_reopen_stage($1,'correção')", [raw.id]));
    await denied(as(users[name], "select admin_unpublish_chapter($1)", [c.id]));
    await denied(as(users[name], "select admin_delete_chapter($1,'Distant Sky #20')", [c.id]));
    await denied(as(users[name], "select admin_delete_catalog_chapters(array[$1::uuid],'EXCLUIR')", [c.catalog_id]));
  }
  await denied(as(users.admin, "select admin_assign_stage($1,$2)", [raw.id, users.translator]));
  await denied(as(users.admin, "select admin_assign_stage($1,$2)", [(await stage(c, "TYPESET")).id, users.type]));
  await as(users.admin, "select admin_assign_stage($1,$2)", [raw.id, users.raw2]);
  ok((await stage(c, "RAW")).assigned_to === users.raw2);
  ok((await notices(users.raw2, c)).rows.some(n => n.kind === "task_assigned"));
  await as(users.admin, "select admin_assign_stage($1,null)", [raw.id]);
  ok((await stage(c, "RAW")).status === "AVAILABLE");
  ok(!(await notices(users.raw2, c)).rows.some(n => n.kind === "task_assigned"));
  await as(users.raw, "select claim_stage($1)", [raw.id]);
  ok((await notices(users.raw2, c)).rowCount === 0);
  await upload(c, "RAW", users.raw);
  await as(users.admin, "select admin_cancel_production($1)", [c.id]);
  ok((await sql("select status from work_chapter_catalog where id=$1", [c.catalog_id])).rows[0].status === "TODO");
  ok((await sql("select * from artifacts where chapter_id=$1", [c.id])).rowCount === 1);
  ok((await sql("select * from chapter_stages where chapter_id=$1 and assigned_to is not null", [c.id])).rowCount === 0);
  await denied(as(users.raw, "select complete_stage($1)", [raw.id]));
  await denied(as(users.raw, "select claim_stage($1)", [raw.id]));
  const restart = await Promise.allSettled([users.raw, users.raw2].map(user => as(user, "select to_jsonb(start_catalog_production($1)) c", [c.catalog_id])));
  ok(restart.filter(r => r.status === "fulfilled").length === 1);
  ok(restart.find(r => r.status === "fulfilled").value.rows[0].c.id === c.id);
  ok((await sql("select * from chapters where catalog_id=$1", [c.catalog_id])).rowCount === 1);
  const owner = (await stage(c, "RAW")).assigned_to;
  await denied(as(owner, "select complete_stage($1)", [raw.id])); // old files never become current after restart
  await finish(c, "RAW", owner);
  const clean = await stage(c, "CLEAN_REDRAW");
  ok((await notices(users.clean, c)).rowCount === 1);
  ok((await notices(users.clean2, c)).rowCount === 1);
  const notice = (await notices(users.clean, c)).rows[0];
  ok((await as(users.outsider, "select notification_is_current(jsonb_populate_record(null::notifications,$1::jsonb)) allowed", [JSON.stringify(notice)])).rows[0].allowed === false);
  ok((await as(users.raw, "select notification_is_current(jsonb_populate_record(null::notifications,$1::jsonb)) allowed", [JSON.stringify(notice)])).rows[0].allowed === false);
  await as(users.clean, "update notifications set read_at=now() where id=$1", [notice.id]);
  ok((await notices(users.clean, c)).rowCount === 0);
  await as(users.clean2, "select claim_stage($1)", [clean.id]);
  ok((await notices(users.clean2, c)).rowCount === 0);
  ok(!(await notices(users.admin, c)).rows.some(n => n.chapter_stage_id === clean.id));
  await as(users.clean2, "select release_stage($1)", [clean.id]);
  ok((await notices(users.clean, c)).rowCount === 1);
  await finish(c, "CLEAN_REDRAW", users.clean);
  await finish(c, "TRANSLATION", users.translator);
  await finish(c, "TYPESET", users.type);
  const review = await stage(c, "REVIEW");
  await as(users.review, "select claim_stage($1)", [review.id]);
  await as(users.review, "select review_chapter($1,true)", [review.id]);
  await as(users.admin, "select mark_chapter_published($1)", [c.id]);
  ok((await notices(users.admin, c)).rowCount === 0);
  await denied(as(users.admin, "select admin_reopen_stage($1,'corrigir')", [clean.id]));
  await as(users.admin, "select admin_unpublish_chapter($1)", [c.id]);
  ok((await notices(users.admin, c)).rows.some(n => n.kind === "chapter_ready"));
  const creditsBefore = (await sql("select * from stage_completions where chapter_id=$1", [c.id])).rowCount;
  for (const target of ["REVIEW", "TYPESET", "TRANSLATION", "CLEAN_REDRAW", "RAW"]) {
    await as(users.admin, "select admin_reopen_stage($1,'Validação de correção')", [(await stage(c, target)).id]);
    ok((await stage(c, "READY")).status === "WAITING");
    ok((await sql("select status from work_chapter_catalog where id=$1", [c.catalog_id])).rows[0].status === "IN_PRODUCTION");
    ok((await sql("select * from stage_completions where chapter_id=$1", [c.id])).rowCount === creditsBefore);
  }
  ok(!(await notices(users.admin, c)).rows.some(n => n.kind === "chapter_ready"));
  await denied(as(users.admin, "select admin_delete_chapter($1,'')", [c.id]));
  await as(users.admin, "select admin_delete_chapter($1,'Distant Sky #20')", [c.id]);
  for (const table of ["chapters", "chapter_stages", "artifacts", "comments", "stage_completions", "notifications"])
    ok((await sql(`select * from ${table} where ${table === "chapters" ? "id" : "chapter_id"}=$1`, [c.id])).rowCount === 0);
  ok((await sql("select * from work_chapter_catalog where id=$1", [c.catalog_id])).rowCount === 0);
  ok((await as(users.admin, "select * from chapter_admin_audit where chapter_id=$1 and action='deleted'", [c.id])).rowCount === 1);
  ok((await as(users.raw, "select * from chapter_admin_audit")).rowCount === 0);
  // Cancellation must work at every point of production, preserving all prior credits.
  for (const [index, target] of ["RAW", "CLEAN_REDRAW", "TRANSLATION", "TYPESET", "REVIEW"].entries()) {
    const chapter = await start(30 + index);
    if (target !== "RAW") await finish(chapter, "RAW", users.raw);
    if (["TYPESET", "REVIEW"].includes(target)) {
      await finish(chapter, "CLEAN_REDRAW", users.clean); await finish(chapter, "TRANSLATION", users.translator);
    }
    if (target === "REVIEW") await finish(chapter, "TYPESET", users.type);
    const s = await stage(chapter, target);
    if (s.status === "AVAILABLE") await as(users.admin, "select claim_stage($1)", [s.id]);
    const count = (await sql("select * from stage_completions where chapter_id=$1", [chapter.id])).rowCount;
    await as(users.admin, "select admin_cancel_production($1)", [chapter.id]);
    ok((await notices(users.admin, chapter)).rowCount === 0);
    ok((await sql("select * from stage_completions where chapter_id=$1", [chapter.id])).rowCount === count);
  }
  const raceChapter = await start(50);
  await upload(raceChapter, "RAW", users.raw);
  await Promise.allSettled([
    as(users.raw, "select complete_stage($1)", [(await stage(raceChapter, "RAW")).id]),
    as(users.admin, "select admin_cancel_production($1)", [raceChapter.id]),
  ]);
  ok((await sql("select cancelled_at from chapters where id=$1", [raceChapter.id])).rows[0].cancelled_at !== null);
  ok((await stage(raceChapter, "CLEAN_REDRAW")).status === "WAITING");
  const published = await start(60);
  for (const [code, user] of [["RAW", users.raw], ["CLEAN_REDRAW", users.clean], ["TRANSLATION", users.translator], ["TYPESET", users.type]]) await finish(published, code, user);
  const qc = await stage(published, "REVIEW");
  await as(users.review, "select claim_stage($1)", [qc.id]);
  await as(users.review, "select review_chapter($1,true)", [qc.id]);
  await as(users.admin, "select mark_chapter_published($1)", [published.id]);
  await as(users.admin, "select admin_delete_chapter($1,'Distant Sky #60')", [published.id]);
  ok((await sql("select id from chapters where id=$1", [published.id])).rowCount === 0);
  const bulk = await start(61);
  await denied(as(users.admin, "select admin_delete_catalog_chapters(array[$1::uuid],'')", [bulk.catalog_id]));
  ok((await as(users.admin, "select admin_delete_catalog_chapters(array[$1::uuid,$2::uuid],'EXCLUIR') count", [bulk.catalog_id, raceChapter.catalog_id])).rows[0].count === 2);
  ok((await sql("select id from chapters where id=any($1::uuid[])", [[bulk.id,raceChapter.id]])).rowCount === 0);
  const retained = await upload(await start(99), "RAW", users.raw);
  await denied(as(users.raw, "select admin_delete_work($1,'Distant Sky')", [workId]));
  await denied(as(users.outsider, "select admin_delete_work($1,'Distant Sky')", [workId]));
  await denied(as(users.admin, "select admin_delete_work($1,'wrong title')", [workId]));
  await denied(as(users.admin, "delete from works where id=$1", [workId]));
  await as(users.admin, "select admin_delete_work($1,'Distant Sky')", [workId]);
  ok((await sql("select * from works where id=$1", [workId])).rowCount === 0);
  ok((await sql("select * from chapters where work_id=$1", [workId])).rowCount === 0);
  ok((await sql("select * from work_chapter_catalog where work_id=$1", [workId])).rowCount === 0);
  ok((await sql("select * from artifacts where id=$1", [retained.id])).rowCount === 0);
  const audit = (await sql("select retained_file_references from work_deletion_audit where work_id=$1", [workId])).rows[0].retained_file_references;
  ok(audit.artifacts.some(a => a.id === retained.id && a.provider_key === retained.provider_key));
  ok((await sql("select * from storage.objects where name=$1", [retained.provider_key])).rowCount === 1);
  await denied(as(users.raw, "select * from work_deletion_audit"));
  await denied(as(users.admin, "select * from work_deletion_audit"));
  console.log(`PASS: ${checks} admin/inbox/work-deletion assertions with real PostgreSQL, RLS, preserved storage references and races (${database}).`);
} finally { await pool.end(); }
