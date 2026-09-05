import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// Only an isolated local database is accepted. Never point tests at production.
const host = "127.0.0.1";
const port = Number(process.env.NOX_TEST_PG_PORT || 55432);
export const database = `nox_test_${Date.now()}`;
const options = { host, port, user: process.env.USER || "awerkori" };
const root = new pg.Client({ ...options, database: "postgres" });
await root.connect();
await root.query(
  `create database ${database} template template0 encoding 'UTF8'`,
);
await root.end();
export const pool = new pg.Pool({ ...options, database, max: 15 });
export const sql = (text, args = []) => pool.query(text, args);
export async function as(user, text, args = []) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [
      user,
    ]);
    const result = await client.query(text, args);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
await sql(`
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
create schema auth; create schema storage; create schema extensions; create schema vault; create schema net; create schema cron;
create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
create table auth.identities(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),provider text,identity_data jsonb,updated_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));
alter table storage.objects enable row level security;
create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
create table vault.decrypted_secrets(name text,decrypted_secret text);
create table net._http_response(id bigint,status_code integer,error_msg text);
create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as $$ select 1::bigint $$;
create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
create publication supabase_realtime;
grant usage on schema public,auth,storage to anon,authenticated,service_role;
grant all on storage.objects to authenticated,service_role;
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
`);
for (const file of (
  await readdir(new URL("../supabase/migrations/", import.meta.url))
).sort()) {
  const original = await readFile(
    new URL(`../supabase/migrations/${file}`, import.meta.url),
    "utf8",
  );
  // Supabase-only HTTP/scheduler extensions are stubbed; all application SQL,
  // constraints, grants, triggers and RLS execute unmodified in PostgreSQL.
  await sql(
    original.replace(
      /^create extension if not exists (?:pg_net|pg_cron|supabase_vault).*;$/gm,
      "",
    ),
  );
}
export const users = {};
for (const [name, roles, admin] of [
  ["admin", [], true],
  ["raw", ["RAW_PROVIDER"]],
  ["raw2", ["RAW_PROVIDER"]],
  ["clean", ["CLEAN_REDRAW"]],
  ["clean2", ["CLEAN_REDRAW"]],
  ["translator", ["TRANSLATOR"]],
  ["type", ["TYPESETTER"]],
  ["review", ["REVIEWER_QC"]],
  ["multi", ["RAW_PROVIDER", "TYPESETTER"]],
  ["outsider", []],
]) {
  const id = randomUUID();
  users[name] = id;
  await sql("insert into auth.users(id,email) values($1,$2)", [
    id,
    `${name}@example.test`,
  ]);
  await sql(
    "insert into auth.identities(user_id,provider,identity_data) values($1,'github',$2)",
    [id, { user_name: name, full_name: name }],
  );
  if (name !== "outsider") {
    await sql(
      "insert into staff_invites(github_login,roles,is_admin) values($1,$2,$3)",
      [name, roles, !!admin],
    );
    await as(id, "select claim_staff_invite()");
  }
}
export const workId = randomUUID();
await as(
  users.admin,
  "insert into works(id,title,synopsis,aliases) values($1,$2,$3,$4)",
  [workId, "Distant Sky", "Uma cidade em silêncio.", ["Céu distante"]],
);
await as(users.admin, "select add_catalog_chapter_range($1,1,117)", [workId]);
export async function start(number = 81, user = users.raw) {
  const {
    rows: [catalog],
  } = await sql(
    "select id from work_chapter_catalog where work_id=$1 and number=$2",
    [workId, number],
  );
  const {
    rows: [{ chapter }],
  } = await as(user, "select to_jsonb(start_catalog_production($1)) chapter", [
    catalog.id,
  ]);
  return chapter;
}
export async function stage(chapter, code) {
  return (
    await sql("select * from chapter_stages where chapter_id=$1 and stage=$2", [
      chapter.id,
      code,
    ])
  ).rows[0];
}
export async function upload(chapter, code, user, versionText = "data") {
  const bytes = Buffer.byteLength(versionText);
  const {
    rows: [{ artifact }],
  } = await as(
    user,
    "select to_jsonb(reserve_artifact_upload($1,$2,'chapter.txt','text/plain',$3,null)) artifact",
    [chapter.id, code, bytes],
  );
  await as(
    user,
    "insert into storage.objects(bucket_id,name,metadata) values('scan-artifacts',$1,$2)",
    [artifact.provider_key, { size: bytes }],
  );
  return (
    await as(user, "select to_jsonb(finalize_artifact_upload($1)) artifact", [
      artifact.id,
    ])
  ).rows[0].artifact;
}
export async function finish(chapter, code, user) {
  let s = await stage(chapter, code);
  if (s.status === "AVAILABLE")
    await as(user, "select claim_stage($1)", [s.id]);
  await upload(chapter, code, user);
  await as(user, "select complete_stage($1)", [s.id]);
}
