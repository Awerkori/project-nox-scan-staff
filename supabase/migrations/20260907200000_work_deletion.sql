-- New administrative operation only. No storage transfers or workflow changes.
create table public.work_deletion_audit (
  id bigint generated always as identity primary key,
  work_id uuid not null, work_title text not null,
  actor_id uuid references public.profiles(id), deleted_at timestamptz not null default now(),
  retained_file_references jsonb not null
);
alter table public.work_deletion_audit enable row level security;
-- Provider references remain backend-only, like telegram_artifact_parts.
revoke all on public.work_deletion_audit from public,anon,authenticated;
grant select on public.work_deletion_audit to service_role;
create function public.admin_delete_work(p_work_id uuid,p_confirmation text) returns void
language plpgsql security definer set search_path=public as $$
declare w public.works; c record; files jsonb; parts jsonb;
begin
  if not public.is_admin() then raise exception 'Somente administradores podem excluir obras'; end if;
  select * into w from public.works where id=p_work_id for update;
  if not found then raise exception 'Obra não encontrada'; end if;
  if p_confirmation is distinct from w.title then raise exception 'Digite o título completo da obra para confirmar'; end if;
  -- Lock existing production before capturing references. Work lock also blocks
  -- new catalog/production children through the FK until deletion commits.
  perform 1 from public.chapters where work_id=w.id order by id for update;
  select coalesce(jsonb_agg(to_jsonb(a)),'[]') into files from public.artifacts a join public.chapters ch on ch.id=a.chapter_id where ch.work_id=w.id;
  select coalesce(jsonb_agg(to_jsonb(p)),'[]') into parts from public.telegram_artifact_parts p join public.artifacts a on a.id=p.artifact_id join public.chapters ch on ch.id=a.chapter_id where ch.work_id=w.id;
  insert into public.work_deletion_audit(work_id,work_title,actor_id,retained_file_references)
    values(w.id,w.title,auth.uid(),jsonb_build_object('cover_path',w.cover_path,'artifacts',files,'parts',parts));
  for c in select id from public.chapters where work_id=w.id order by id loop
    perform public.admin_delete_chapter(c.id,public.chapter_label(c.id));
  end loop;
  delete from public.works where id=w.id;
end $$;
revoke execute on function public.admin_delete_work(uuid,text) from public,anon;
grant execute on function public.admin_delete_work(uuid,text) to authenticated;
-- Prevent a direct browser DELETE from bypassing confirmation and the retained
-- references audit. Existing admin insert/update/read policies remain intact.
revoke delete on public.works from anon,authenticated;
