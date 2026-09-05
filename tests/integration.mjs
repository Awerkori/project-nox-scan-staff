import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  sql,
  as,
  pool,
  users,
  workId,
  start,
  stage,
  upload,
  finish,
  database,
} from "./database.mjs";
let checks = 0;
const ok = (condition) => {
  assert.ok(condition);
  checks++;
};
async function denied(promise) {
  await assert.rejects(promise);
  checks++;
}
try {
  for (const before of [true, false]) {
    const name = `invite_${before}`,
      id = randomUUID();
    if (before)
      await sql(
        "insert into staff_invites(github_login,roles) values($1,'{TRANSLATOR}')",
        [name],
      );
    await sql("insert into auth.users(id,email) values($1,$2)", [
      id,
      `${name}@example.test`,
    ]);
    await sql(
      "insert into auth.identities(user_id,provider,identity_data) values($1,'github',$2)",
      [id, { user_name: name }],
    );
    if (!before) {
      await denied(as(id, "select claim_staff_invite()"));
      await sql(
        "insert into staff_invites(github_login,roles) values($1,'{TRANSLATOR}')",
        [name],
      );
    }
    await as(id, "select claim_staff_invite()");
    await as(id, "select claim_staff_invite()");
    ok(
      (await as(id, "select * from staff_members where user_id=$1", [id]))
        .rowCount === 1,
    );
    await sql("update staff_members set is_active=false where user_id=$1", [
      id,
    ]);
    await denied(as(id, "select claim_staff_invite()"));
    ok((await as(id, "select * from chapters")).rowCount === 0);
  }
  await denied(as(users.outsider, "select claim_staff_invite()"));
  await denied(
    as(
      users.admin,
      "update staff_members set is_admin=false where user_id=$1",
      [users.admin],
    ),
  );
  await denied(
    as(users.admin, "delete from staff_members where user_id=$1", [
      users.admin,
    ]),
  );
  for (const fn of [
    "refresh_chapter_workflow",
    "notify_stage_available",
    "initialize_chapter_stages",
    "create_chapter_range",
    "admin_assign_stage",
  ]) {
    ok(
      !(
        await sql(
          "select bool_or(has_function_privilege('authenticated',oid,'execute')) permitted from pg_proc where proname=$1",
          [fn],
        )
      ).rows[0].permitted,
    );
  }
  const cId = (
    await sql(
      "select id from work_chapter_catalog where work_id=$1 and number=81",
      [workId],
    )
  ).rows[0].id;
  const race = await Promise.allSettled(
    [users.raw, users.raw2].map((u) =>
      as(u, "select to_jsonb(start_catalog_production($1)) chapter", [cId]),
    ),
  );
  ok(race.filter((r) => r.status === "fulfilled").length === 1);
  const chapter = race.find((r) => r.status === "fulfilled").value.rows[0]
    .chapter;
  const raw = await stage(chapter, "RAW");
  const rawUser = raw.assigned_to;
  await denied(as(users.translator, "select claim_stage($1)", [raw.id]));
  await denied(as(rawUser, "select complete_stage($1)", [raw.id]));
  await denied(
    as(users.raw, "select update_catalog_chapters($1,$2)", [
      [cId],
      "COMPLETED",
    ]),
  );
  await denied(as(users.admin, "select delete_catalog_chapters($1)", [[cId]]));
  const versions = await Promise.all([
    upload(chapter, "RAW", rawUser, "one"),
    upload(chapter, "RAW", rawUser, "two"),
  ]);
  ok(new Set(versions.map((v) => v.version)).size === 2);
  ok(
    (
      await sql("select * from artifacts where chapter_id=$1 and is_current", [
        chapter.id,
      ])
    ).rowCount === 1,
  );
  await as(rawUser, "select complete_stage($1)", [raw.id]);
  ok((await stage(chapter, "CLEAN_REDRAW")).status === "AVAILABLE");
  ok((await stage(chapter, "TRANSLATION")).status === "AVAILABLE");
  const type = await stage(chapter, "TYPESET");
  await denied(as(users.type, "select claim_stage($1)", [type.id]));
  const clean = await stage(chapter, "CLEAN_REDRAW");
  const race2 = await Promise.allSettled(
    [users.clean, users.clean2].map((u) =>
      as(u, "select claim_stage($1)", [clean.id]),
    ),
  );
  ok(race2.filter((r) => r.status === "fulfilled").length === 1);
  const cleaner = (await stage(chapter, "CLEAN_REDRAW")).assigned_to;
  await Promise.all([
    finish(chapter, "CLEAN_REDRAW", cleaner),
    finish(chapter, "TRANSLATION", users.translator),
  ]);
  ok((await stage(chapter, "TYPESET")).status === "AVAILABLE");
  await finish(chapter, "TYPESET", users.type);
  for (const target of ["TYPESET", "TRANSLATION", "CLEAN_REDRAW"]) {
    const qc = await stage(chapter, "REVIEW");
    ok(qc.status === "AVAILABLE");
    await as(users.review, "select claim_stage($1)", [qc.id]);
    await denied(as(users.raw, "select review_chapter($1,true)", [qc.id]));
    await denied(
      as(users.review, "select review_chapter($1,false,null,$2)", [
        qc.id,
        target,
      ]),
    );
    await as(users.review, "select review_chapter($1,false,$2,$3)", [
      qc.id,
      "Corrigir página 2",
      target,
    ]);
    const s = await stage(chapter, target),
      u = {
        TYPESET: users.type,
        TRANSLATION: users.translator,
        CLEAN_REDRAW: cleaner,
      }[target];
    await as(u, "select claim_stage($1)", [s.id]);
    await denied(as(u, "select complete_stage($1)", [s.id]));
    ok((await stage(chapter, "READY")).status === "WAITING");
    ok(
      (await sql("select status from work_chapter_catalog where id=$1", [cId]))
        .rows[0].status === "IN_PRODUCTION",
    );
    await finish(chapter, target, u);
    if (target !== "TYPESET") await finish(chapter, "TYPESET", users.type);
  }
  const qc = await stage(chapter, "REVIEW");
  await as(users.review, "select claim_stage($1)", [qc.id]);
  await as(users.review, "select review_chapter($1,true)", [qc.id]);
  ok(
    (await sql("select status from work_chapter_catalog where id=$1", [cId]))
      .rows[0].status === "COMPLETED",
  );
  await denied(
    as(users.raw, "select mark_chapter_published($1)", [chapter.id]),
  );
  await as(users.admin, "select mark_chapter_published($1)", [chapter.id]);
  await as(users.admin, "select mark_chapter_published($1)", [chapter.id]);
  ok(
    (await sql("select published_at from chapters where id=$1", [chapter.id]))
      .rows[0].published_at,
  );
  ok(
    (
      await sql(
        "select * from activity_log where chapter_id=$1 and action='published'",
        [chapter.id],
      )
    ).rowCount === 1,
  );
  ok(
    (
      await sql(
        "select distinct stage from stage_completions where chapter_id=$1",
        [chapter.id],
      )
    ).rowCount === 5,
  );
  const next = await start(82);
  const pending = (
    await as(
      users.raw,
      "select to_jsonb(reserve_artifact_upload($1,'RAW','raw.zip','application/zip',3,null)) artifact",
      [next.id],
    )
  ).rows[0].artifact;
  await denied(
    as(users.raw, "select finalize_artifact_upload($1)", [pending.id]),
  );
  await denied(
    as(
      users.translator,
      "select reserve_artifact_upload($1,'RAW','raw.zip','application/zip',3,null)",
      [next.id],
    ),
  );
  await denied(
    as(
      users.translator,
      "insert into storage.objects(bucket_id,name,metadata) values('scan-artifacts',$1,'{\"size\":3}')",
      [pending.provider_key],
    ),
  );
  await denied(
    as(
      users.raw,
      "insert into storage.objects(bucket_id,name) values('scan-artifacts','arbitrary/file.zip')",
    ),
  );
  await denied(
    as(users.outsider, "select claim_stage($1)", [
      (await stage(next, "RAW")).id,
    ]),
  );
  ok(
    (
      await as(
        users.raw,
        "update chapters set published_at=now() where id=$1",
        [next.id],
      )
    ).rowCount === 0,
  );
  // Missing worker configuration must not roll back production completion.
  await finish(next, "RAW", users.raw);
  ok((await stage(next, "CLEAN_REDRAW")).status === "AVAILABLE");
  ok(
    (
      await sql(
        "select * from production_email_outbox where chapter_id=$1 and last_error like '%Vault%'",
        [next.id],
      )
    ).rowCount > 0,
  );
  ok(
    (
      await sql(
        "select chapter_stage_id,availability_version,recipient_id,count(*) from production_email_outbox group by 1,2,3 having count(*)>1",
      )
    ).rowCount === 0,
  );
  const claimed = await Promise.all([
    sql("select * from claim_production_email_jobs(2)"),
    sql("select * from claim_production_email_jobs(2)"),
  ]);
  ok(claimed.reduce((n, r) => n + r.rowCount, 0) > 0);
  ok(
    new Set(claimed.flatMap((r) => r.rows.map((j) => j.id))).size ===
      claimed.reduce((n, r) => n + r.rowCount, 0),
  );
  // Test last-admin contention with distinct users on distinct connections.
  await sql("update staff_members set is_admin=true where user_id=$1", [
    users.raw,
  ]);
  const admins = await Promise.allSettled([
    as(
      users.admin,
      "update staff_members set is_admin=false where user_id=$1",
      [users.admin],
    ),
    as(users.raw, "update staff_members set is_admin=false where user_id=$1", [
      users.raw,
    ]),
  ]);
  ok(admins.filter((r) => r.status === "fulfilled").length === 1);
  ok(
    (await sql("select * from staff_members where is_active and is_admin"))
      .rowCount === 1,
  );
  console.log(
    `PASS: ${checks} database assertions; real PostgreSQL transactions, RLS and concurrency (${database}).`,
  );
} finally {
  await pool.end();
}
