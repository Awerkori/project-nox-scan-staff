-- Project Nox Scan Staff: private production workflow.
-- Run through the Supabase CLI/dashboard migration runner as the database owner.

create extension if not exists pgcrypto;

create type public.role_code as enum ('ADMIN', 'RAW_PROVIDER', 'TRANSLATOR', 'CLEAN_REDRAW', 'TYPESETTER', 'REVIEWER_QC');
create type public.stage_code as enum ('RAW', 'CLEAN_REDRAW', 'TRANSLATION', 'TYPESET', 'REVIEW', 'READY');
create type public.stage_status as enum ('WAITING', 'AVAILABLE', 'IN_PROGRESS', 'COMPLETED', 'REJECTED');
create type public.work_status as enum ('ACTIVE', 'PAUSED', 'COMPLETED');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  github_login text unique,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.staff_members (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  github_login text not null unique,
  display_name text,
  is_active boolean not null default true,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.roles (code public.role_code primary key, label text not null);
insert into public.roles (code, label) values
 ('ADMIN', 'Administrador'), ('RAW_PROVIDER', 'Raw Provider'), ('TRANSLATOR', 'Tradutor'),
 ('CLEAN_REDRAW', 'Cleaner / Redrawer'), ('TYPESETTER', 'Typesetter'), ('REVIEWER_QC', 'Revisor / QC');

create table public.user_roles (
  user_id uuid not null references public.staff_members(user_id) on delete cascade,
  role_code public.role_code not null references public.roles(code),
  primary key (user_id, role_code)
);

create table public.works (
  id uuid primary key default gen_random_uuid(), title text not null, aliases text[] not null default '{}',
  cover_path text, status public.work_status not null default 'ACTIVE', created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(title)
);

create table public.chapters (
  id uuid primary key default gen_random_uuid(), work_id uuid not null references public.works(id) on delete cascade,
  number text not null, title text, created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(work_id, number)
);

create table public.chapter_stages (
  id uuid primary key default gen_random_uuid(), chapter_id uuid not null references public.chapters(id) on delete cascade,
  stage public.stage_code not null, status public.stage_status not null default 'WAITING', assigned_to uuid references public.profiles(id),
  assigned_at timestamptz, completed_at timestamptz, rejection_reason text, updated_at timestamptz not null default now(),
  unique(chapter_id, stage)
);

create table public.stage_assignments (
  id uuid primary key default gen_random_uuid(), chapter_stage_id uuid not null references public.chapter_stages(id) on delete cascade,
  user_id uuid not null references public.profiles(id), assigned_by uuid references public.profiles(id),
  started_at timestamptz not null default now(), ended_at timestamptz, released_at timestamptz
);

create table public.artifacts (
  id uuid primary key default gen_random_uuid(), chapter_id uuid not null references public.chapters(id) on delete cascade,
  stage public.stage_code not null, provider text not null default 'supabase', provider_key text not null,
  original_name text not null, mime_type text, byte_size bigint not null check (byte_size >= 0),
  version integer not null, uploaded_by uuid not null references public.profiles(id), note text,
  created_at timestamptz not null default now(), unique(chapter_id, stage, version), unique(provider, provider_key)
);

create table public.comments (
  id uuid primary key default gen_random_uuid(), chapter_id uuid not null references public.chapters(id) on delete cascade,
  stage public.stage_code, author_id uuid not null references public.profiles(id), body text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.activity_log (
  id bigint generated always as identity primary key, chapter_id uuid references public.chapters(id) on delete cascade,
  actor_id uuid references public.profiles(id), action text not null, stage public.stage_code, metadata jsonb not null default '{}', created_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(), recipient_id uuid not null references public.profiles(id) on delete cascade,
  chapter_id uuid references public.chapters(id) on delete cascade, chapter_stage_id uuid references public.chapter_stages(id) on delete cascade,
  kind text not null, body text not null, link_path text,
  read_at timestamptz, created_at timestamptz not null default now()
);

create index chapter_stages_queue_idx on public.chapter_stages(stage, status, updated_at);
create index artifacts_chapter_stage_idx on public.artifacts(chapter_id, stage, version desc);
create index comments_chapter_idx on public.comments(chapter_id, created_at);
create index notifications_recipient_idx on public.notifications(recipient_id, read_at, created_at desc);
-- Defense in depth: even an administrative misuse cannot leave two active owners for one stage.
create unique index one_active_assignment_per_stage on public.stage_assignments(chapter_stage_id) where ended_at is null and released_at is null;

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
create trigger profiles_touch before update on public.profiles for each row execute procedure public.touch_updated_at();
create trigger staff_touch before update on public.staff_members for each row execute procedure public.touch_updated_at();
create trigger works_touch before update on public.works for each row execute procedure public.touch_updated_at();
create trigger chapters_touch before update on public.chapters for each row execute procedure public.touch_updated_at();
create trigger stages_touch before update on public.chapter_stages for each row execute procedure public.touch_updated_at();
create trigger comments_touch before update on public.comments for each row execute procedure public.touch_updated_at();

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, github_login, display_name, avatar_url)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'user_name', new.raw_user_meta_data ->> 'preferred_username'), new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'avatar_url')
  on conflict (id) do update set github_login = excluded.github_login, display_name = excluded.display_name, avatar_url = excluded.avatar_url;
  return new;
end $$;
create trigger auth_user_profile after insert on auth.users for each row execute procedure public.handle_new_user();

create or replace function public.is_active_staff() returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.staff_members where user_id = auth.uid() and is_active)
$$;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.staff_members where user_id = auth.uid() and is_active and is_admin)
$$;
create or replace function public.has_role(p_role public.role_code) returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists(select 1 from public.user_roles where user_id = auth.uid() and role_code = p_role)
$$;

create or replace function public.required_role(p_stage public.stage_code) returns public.role_code language sql immutable as $$
 select case p_stage when 'RAW' then 'RAW_PROVIDER'::public.role_code when 'CLEAN_REDRAW' then 'CLEAN_REDRAW'::public.role_code
 when 'TRANSLATION' then 'TRANSLATOR'::public.role_code when 'TYPESET' then 'TYPESETTER'::public.role_code when 'REVIEW' then 'REVIEWER_QC'::public.role_code else 'ADMIN'::public.role_code end
$$;

create or replace function public.add_activity(p_chapter uuid, p_action text, p_stage public.stage_code default null, p_metadata jsonb default '{}') returns void language plpgsql security definer set search_path = public as $$
begin insert into public.activity_log(chapter_id, actor_id, action, stage, metadata) values(p_chapter, auth.uid(), p_action, p_stage, p_metadata); end $$;

create or replace function public.chapter_label(p_chapter_id uuid) returns text language sql stable security definer set search_path = public as $$
 select w.title || ' #' || c.number from public.chapters c join public.works w on w.id=c.work_id where c.id=p_chapter_id
$$;

create or replace function public.notify_stage_available(p_stage_id uuid, p_reopened boolean default false) returns void language plpgsql security definer set search_path = public as $$
declare v_stage public.chapter_stages; v_role public.role_code; v_label text; v_name text; v_icon text;
begin
  select * into v_stage from public.chapter_stages where id=p_stage_id;
  if not found or v_stage.stage in ('READY') then return; end if;
  v_role := public.required_role(v_stage.stage); v_label := public.chapter_label(v_stage.chapter_id);
  select case v_stage.stage when 'RAW' then 'Raw Provider' when 'CLEAN_REDRAW' then 'Clean / Redraw' when 'TRANSLATION' then 'Tradução' when 'TYPESET' then 'Type' else 'Revisão / QC' end into v_name;
  select case v_stage.stage when 'RAW' then '📥' when 'CLEAN_REDRAW' then '🎨' when 'TRANSLATION' then '🌐' when 'TYPESET' then '✒️' else '🔎' end into v_icon;
  insert into public.notifications(recipient_id,chapter_id,chapter_stage_id,kind,body,link_path)
  select distinct sm.user_id,v_stage.chapter_id,v_stage.id,case when p_reopened then 'stage_reopened' else 'stage_available' end,
    v_icon || ' ' || v_label || case when p_reopened then ' voltou a ficar disponível para ' else ' está disponível para ' end || v_name || '.', '#/chapters/' || v_stage.chapter_id
  from public.staff_members sm left join public.user_roles ur on ur.user_id=sm.user_id
  where sm.is_active and (sm.is_admin or ur.role_code=v_role);
  perform public.add_activity(v_stage.chapter_id,'stage_available',v_stage.stage);
end $$;

create or replace function public.initialize_chapter_stages() returns trigger language plpgsql security definer set search_path = public as $$
declare v_raw_id uuid;
begin
  insert into public.chapter_stages(chapter_id, stage, status) values
   (new.id,'RAW','AVAILABLE'), (new.id,'CLEAN_REDRAW','WAITING'), (new.id,'TRANSLATION','WAITING'),
   (new.id,'TYPESET','WAITING'), (new.id,'REVIEW','WAITING'), (new.id,'READY','WAITING');
  select id into v_raw_id from public.chapter_stages where chapter_id=new.id and stage='RAW';
  perform public.notify_stage_available(v_raw_id);
  return new;
end $$;
create trigger chapter_stages_initialize after insert on public.chapters for each row execute procedure public.initialize_chapter_stages();

create or replace function public.refresh_chapter_workflow(p_chapter_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare raw_done boolean; clean_done boolean; translation_done boolean; type_done boolean; review_done boolean; v_id uuid;
begin
  select status = 'COMPLETED' into raw_done from public.chapter_stages where chapter_id=p_chapter_id and stage='RAW';
  select status = 'COMPLETED' into clean_done from public.chapter_stages where chapter_id=p_chapter_id and stage='CLEAN_REDRAW';
  select status = 'COMPLETED' into translation_done from public.chapter_stages where chapter_id=p_chapter_id and stage='TRANSLATION';
  select status = 'COMPLETED' into type_done from public.chapter_stages where chapter_id=p_chapter_id and stage='TYPESET';
  select status = 'COMPLETED' into review_done from public.chapter_stages where chapter_id=p_chapter_id and stage='REVIEW';
  if raw_done then for v_id in update public.chapter_stages set status='AVAILABLE' where chapter_id=p_chapter_id and stage in ('CLEAN_REDRAW','TRANSLATION') and status='WAITING' returning id loop perform public.notify_stage_available(v_id); end loop; end if;
  if clean_done and translation_done then for v_id in update public.chapter_stages set status='AVAILABLE' where chapter_id=p_chapter_id and stage='TYPESET' and status='WAITING' returning id loop perform public.notify_stage_available(v_id); end loop; end if;
  if type_done then for v_id in update public.chapter_stages set status='AVAILABLE' where chapter_id=p_chapter_id and stage='REVIEW' and status='WAITING' returning id loop perform public.notify_stage_available(v_id); end loop; end if;
  if review_done then update public.chapter_stages set status='COMPLETED', completed_at=coalesce(completed_at,now()) where chapter_id=p_chapter_id and stage='READY' and status <> 'COMPLETED'; end if;
end $$;

create or replace function public.claim_stage(p_stage_id uuid) returns public.chapter_stages language plpgsql security definer set search_path = public as $$
declare v_stage public.chapter_stages;
begin
  select * into v_stage from public.chapter_stages where id=p_stage_id for update;
  if not found then raise exception 'Etapa não encontrada'; end if;
  if not public.has_role(public.required_role(v_stage.stage)) then raise exception 'Sem permissão para esta etapa'; end if;
  if v_stage.status <> 'AVAILABLE' then raise exception 'Esta tarefa acabou de ser assumida por outro membro.' using errcode='P0001'; end if;
  update public.chapter_stages set status='IN_PROGRESS', assigned_to=auth.uid(), assigned_at=now() where id=p_stage_id returning * into v_stage;
  insert into public.stage_assignments(chapter_stage_id,user_id,assigned_by) values(p_stage_id,auth.uid(),auth.uid());
  perform public.add_activity(v_stage.chapter_id, 'claimed', v_stage.stage);
  return v_stage;
end $$;

create or replace function public.release_stage(p_stage_id uuid) returns public.chapter_stages language plpgsql security definer set search_path = public as $$
declare v_stage public.chapter_stages;
begin
  select * into v_stage from public.chapter_stages where id=p_stage_id for update;
  if not found or (v_stage.assigned_to <> auth.uid() and not public.is_admin()) then raise exception 'Você não pode liberar esta tarefa'; end if;
  if v_stage.status <> 'IN_PROGRESS' then raise exception 'A etapa não está em andamento'; end if;
  update public.chapter_stages set status='AVAILABLE', assigned_to=null, assigned_at=null where id=p_stage_id returning * into v_stage;
  update public.stage_assignments set released_at=now(), ended_at=now() where chapter_stage_id=p_stage_id and ended_at is null;
  perform public.add_activity(v_stage.chapter_id,'released',v_stage.stage);
  perform public.notify_stage_available(v_stage.id, true);
  return v_stage;
end $$;

create or replace function public.admin_assign_stage(p_stage_id uuid, p_assignee uuid) returns public.chapter_stages language plpgsql security definer set search_path = public as $$
declare v_stage public.chapter_stages;
begin
  if not public.is_admin() then raise exception 'Somente administradores podem reatribuir tarefas'; end if;
  select * into v_stage from public.chapter_stages where id=p_stage_id for update;
  if not found then raise exception 'Etapa não encontrada'; end if;
  if not exists(select 1 from public.staff_members where user_id=p_assignee and is_active) then raise exception 'Membro inválido'; end if;
  if not (exists(select 1 from public.staff_members where user_id=p_assignee and is_admin) or exists(select 1 from public.user_roles where user_id=p_assignee and role_code=public.required_role(v_stage.stage))) then raise exception 'Membro sem cargo compatível'; end if;
  update public.stage_assignments set released_at=now(), ended_at=now() where chapter_stage_id=p_stage_id and ended_at is null;
  update public.chapter_stages set status='IN_PROGRESS',assigned_to=p_assignee,assigned_at=now() where id=p_stage_id returning * into v_stage;
  insert into public.stage_assignments(chapter_stage_id,user_id,assigned_by) values(p_stage_id,p_assignee,auth.uid());
  perform public.add_activity(v_stage.chapter_id,'reassigned',v_stage.stage,jsonb_build_object('assignee',p_assignee));
  return v_stage;
end $$;

create or replace function public.complete_stage(p_stage_id uuid, p_note text default null) returns public.chapter_stages language plpgsql security definer set search_path = public as $$
declare v_stage public.chapter_stages;
begin
  select * into v_stage from public.chapter_stages where id=p_stage_id for update;
  if not found or (v_stage.assigned_to <> auth.uid() and not public.is_admin()) then raise exception 'Você não é responsável por esta tarefa'; end if;
  if v_stage.status <> 'IN_PROGRESS' then raise exception 'A etapa não está em andamento'; end if;
  if v_stage.stage='REVIEW' then raise exception 'Use review_chapter para concluir QC'; end if;
  update public.chapter_stages set status='COMPLETED', completed_at=now() where id=p_stage_id returning * into v_stage;
  update public.stage_assignments set ended_at=now() where chapter_stage_id=p_stage_id and ended_at is null;
  perform public.add_activity(v_stage.chapter_id, 'completed', v_stage.stage, jsonb_build_object('note',p_note));
  perform public.refresh_chapter_workflow(v_stage.chapter_id);
  return v_stage;
end $$;

create or replace function public.review_chapter(p_stage_id uuid, p_approved boolean, p_reason text default null, p_return_stage public.stage_code default null) returns void language plpgsql security definer set search_path = public as $$
declare v_stage public.chapter_stages; v_chapter_label text; v_target_id uuid;
begin
  select * into v_stage from public.chapter_stages where id=p_stage_id for update;
  if not found or v_stage.stage <> 'REVIEW' or (v_stage.assigned_to <> auth.uid() and not public.is_admin()) then raise exception 'Revisão inválida'; end if;
  if v_stage.status <> 'IN_PROGRESS' then raise exception 'A revisão não está em andamento'; end if;
  if not p_approved and (coalesce(trim(p_reason),'')='' or p_return_stage not in ('CLEAN_REDRAW','TRANSLATION','TYPESET')) then raise exception 'Reprovação exige motivo e etapa de retorno'; end if;
  if p_approved then
    update public.chapter_stages set status='COMPLETED', completed_at=now() where id=p_stage_id;
    perform public.refresh_chapter_workflow(v_stage.chapter_id);
    select w.title || ' #' || c.number into v_chapter_label from public.chapters c join public.works w on w.id=c.work_id where c.id=v_stage.chapter_id;
    insert into public.notifications(recipient_id,chapter_id,kind,body)
      select user_id,v_stage.chapter_id,'chapter_ready',v_chapter_label || ' pronto para publicação.' from public.staff_members where is_active and is_admin;
    perform public.add_activity(v_stage.chapter_id,'approved','REVIEW');
  else
    update public.chapter_stages set status='REJECTED', rejection_reason=p_reason where id=p_stage_id;
    update public.chapter_stages set status='AVAILABLE', assigned_to=null, assigned_at=null, completed_at=null, rejection_reason=null where chapter_id=v_stage.chapter_id and stage=p_return_stage returning id into v_target_id;
    perform public.add_activity(v_stage.chapter_id,'rejected','REVIEW',jsonb_build_object('reason',p_reason,'return_stage',p_return_stage));
    perform public.notify_stage_available(v_target_id, true);
  end if;
end $$;

create or replace function public.create_chapter_range(p_work_id uuid, p_start integer, p_end integer) returns setof public.chapters language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Somente administradores podem criar capítulos'; end if;
  if p_end < p_start then raise exception 'Intervalo inválido'; end if;
  return query insert into public.chapters(work_id,number,created_by) select p_work_id, i::text, auth.uid() from generate_series(p_start,p_end) i on conflict(work_id,number) do nothing returning *;
end $$;

create or replace function public.register_artifact(p_chapter_id uuid, p_stage public.stage_code, p_provider text, p_provider_key text, p_original_name text, p_mime_type text, p_byte_size bigint, p_note text default null) returns public.artifacts language plpgsql security definer set search_path = public as $$
declare v_artifact public.artifacts; v_allowed boolean;
begin
  select public.is_admin() or exists(select 1 from public.chapter_stages where chapter_id=p_chapter_id and stage=p_stage and assigned_to=auth.uid() and status='IN_PROGRESS') into v_allowed;
  if not v_allowed then raise exception 'Sem permissão para enviar este arquivo'; end if;
  insert into public.artifacts(chapter_id,stage,provider,provider_key,original_name,mime_type,byte_size,version,uploaded_by,note)
   values(p_chapter_id,p_stage,p_provider,p_provider_key,p_original_name,p_mime_type,p_byte_size,(select coalesce(max(version),0)+1 from public.artifacts where chapter_id=p_chapter_id and stage=p_stage),auth.uid(),p_note)
   returning * into v_artifact;
  perform public.add_activity(p_chapter_id,'uploaded',p_stage,jsonb_build_object('artifact_id',v_artifact.id,'version',v_artifact.version));
  return v_artifact;
end $$;

alter table public.profiles enable row level security; alter table public.staff_members enable row level security; alter table public.roles enable row level security; alter table public.user_roles enable row level security;
alter table public.works enable row level security; alter table public.chapters enable row level security; alter table public.chapter_stages enable row level security; alter table public.stage_assignments enable row level security; alter table public.artifacts enable row level security; alter table public.comments enable row level security; alter table public.activity_log enable row level security; alter table public.notifications enable row level security;

create policy "staff read profiles" on public.profiles for select using (public.is_active_staff());
create policy "staff read staff" on public.staff_members for select using (public.is_active_staff());
create policy "admin manage staff" on public.staff_members for all using (public.is_admin()) with check (public.is_admin());
create policy "staff read roles" on public.roles for select using (public.is_active_staff());
create policy "staff read user roles" on public.user_roles for select using (public.is_active_staff());
create policy "admin manage user roles" on public.user_roles for all using (public.is_admin()) with check (public.is_admin());
create policy "staff read works" on public.works for select using (public.is_active_staff());
create policy "admin manage works" on public.works for all using (public.is_admin()) with check (public.is_admin());
create policy "staff read chapters" on public.chapters for select using (public.is_active_staff());
create policy "admin manage chapters" on public.chapters for all using (public.is_admin()) with check (public.is_admin());
create policy "staff read stages" on public.chapter_stages for select using (public.is_active_staff());
create policy "staff read assignments" on public.stage_assignments for select using (public.is_active_staff());
create policy "staff read artifacts" on public.artifacts for select using (public.is_active_staff());
create policy "staff read activity" on public.activity_log for select using (public.is_active_staff());
create policy "staff read notifications" on public.notifications for select using (recipient_id=auth.uid() or public.is_admin());
create policy "staff update own notifications" on public.notifications for update using (recipient_id=auth.uid()) with check (recipient_id=auth.uid());
create policy "staff read comments" on public.comments for select using (public.is_active_staff());
create policy "staff create comments" on public.comments for insert with check (public.is_active_staff() and author_id=auth.uid());
create policy "authors edit comments" on public.comments for update using (author_id=auth.uid() or public.is_admin()) with check (author_id=auth.uid() or public.is_admin());

insert into storage.buckets(id,name,public) values ('scan-artifacts','scan-artifacts',false) on conflict (id) do update set public=false;
create policy "staff select scan artifacts" on storage.objects for select using (bucket_id='scan-artifacts' and public.is_active_staff());
create policy "staff upload scan artifacts" on storage.objects for insert with check (bucket_id='scan-artifacts' and public.is_active_staff());
create policy "admin delete scan artifacts" on storage.objects for delete using (bucket_id='scan-artifacts' and public.is_admin());

do $$ begin alter publication supabase_realtime add table public.chapter_stages; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.artifacts; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.comments; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.notifications; exception when duplicate_object then null; end $$;

-- Bootstrap after the first GitHub OAuth login creates profiles row:
-- insert into public.staff_members(user_id, github_login, display_name, is_active, is_admin)
-- select id, github_login, coalesce(display_name, 'Awerkori'), true, true from public.profiles where lower(github_login)='awerkori';
-- insert into public.user_roles(user_id, role_code)
-- select user_id, 'ADMIN' from public.staff_members where lower(github_login)='awerkori' on conflict do nothing;
