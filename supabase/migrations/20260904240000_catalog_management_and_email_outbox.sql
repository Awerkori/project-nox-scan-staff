-- Simple catalog administration and reliable production email notifications.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists supabase_vault with schema vault;

create type public.email_delivery_status as enum ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

alter table public.chapter_stages add column availability_version integer not null default 0;

create table public.production_email_outbox (
  id uuid primary key default gen_random_uuid(),
  chapter_stage_id uuid not null references public.chapter_stages(id) on delete cascade,
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  availability_version integer not null check (availability_version > 0),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  recipient_email text not null,
  work_title text not null,
  chapter_number text not null,
  stage public.stage_code not null,
  status public.email_delivery_status not null default 'PENDING',
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(chapter_stage_id, availability_version, recipient_id)
);
create index production_email_outbox_pending_idx on public.production_email_outbox(status, next_attempt_at, created_at)
  where status in ('PENDING', 'PROCESSING');
create trigger production_email_outbox_touch before update on public.production_email_outbox
  for each row execute procedure public.touch_updated_at();

alter table public.production_email_outbox enable row level security;
create policy "admins inspect production email outbox" on public.production_email_outbox
  for select using(public.is_admin());

create or replace function public.notify_stage_available(p_stage_id uuid, p_reopened boolean default false) returns void
language plpgsql security definer set search_path=public,auth as $$
declare
  v_stage public.chapter_stages;
  v_role public.role_code;
  v_label text;
  v_name text;
  v_icon text;
  v_version integer;
  v_work_title text;
  v_chapter_number text;
begin
  select * into v_stage from public.chapter_stages where id=p_stage_id for update;
  if not found or v_stage.stage='READY' then return; end if;

  update public.chapter_stages set availability_version=availability_version+1
    where id=p_stage_id returning availability_version into v_version;
  v_role := public.required_role(v_stage.stage);
  v_label := public.chapter_label(v_stage.chapter_id);
  select w.title,c.number into v_work_title,v_chapter_number
    from public.chapters c join public.works w on w.id=c.work_id where c.id=v_stage.chapter_id;
  v_name := case v_stage.stage when 'RAW' then 'Raw Provider' when 'CLEAN_REDRAW' then 'Clean / Redraw'
    when 'TRANSLATION' then 'Tradução' when 'TYPESET' then 'Type' else 'Revisão / QC' end;
  v_icon := case v_stage.stage when 'RAW' then '📥' when 'CLEAN_REDRAW' then '🎨'
    when 'TRANSLATION' then '🌐' when 'TYPESET' then '✒️' else '🔎' end;

  insert into public.notifications(recipient_id,chapter_id,chapter_stage_id,kind,body,link_path)
  select distinct sm.user_id,v_stage.chapter_id,v_stage.id,
    case when p_reopened then 'stage_reopened' else 'stage_available' end,
    v_icon||' '||v_label||case when p_reopened then ' voltou a ficar disponível para ' else ' está disponível para ' end||v_name||'.',
    '/chapters/'||v_stage.chapter_id
  from public.staff_members sm left join public.user_roles ur on ur.user_id=sm.user_id
  where sm.is_active and (sm.is_admin or ur.role_code=v_role);

  -- RAW starts directly with its provider and does not need an availability email.
  if v_stage.stage<>'RAW' then
    insert into public.production_email_outbox(
      chapter_stage_id,chapter_id,availability_version,recipient_id,recipient_email,work_title,chapter_number,stage
    )
    select v_stage.id,v_stage.chapter_id,v_version,sm.user_id,au.email,v_work_title,v_chapter_number,v_stage.stage
    from public.staff_members sm
    join public.user_roles ur on ur.user_id=sm.user_id and ur.role_code=v_role
    join auth.users au on au.id=sm.user_id
    where sm.is_active and coalesce(trim(au.email),'')<>''
    on conflict(chapter_stage_id,availability_version,recipient_id) do nothing;
  end if;
  perform public.add_activity(v_stage.chapter_id,'stage_available',v_stage.stage,jsonb_build_object('availability_version',v_version));
end $$;

-- A rejected review must become available again only after the corrected Type
-- is complete. The original implementation only reopened REVIEW from WAITING,
-- leaving corrected chapters stuck in REJECTED.
create or replace function public.refresh_chapter_workflow(p_chapter_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare
  raw_done boolean;
  clean_done boolean;
  translation_done boolean;
  type_done boolean;
  review_done boolean;
  v_id uuid;
begin
  select status='COMPLETED' into raw_done from public.chapter_stages where chapter_id=p_chapter_id and stage='RAW';
  select status='COMPLETED' into clean_done from public.chapter_stages where chapter_id=p_chapter_id and stage='CLEAN_REDRAW';
  select status='COMPLETED' into translation_done from public.chapter_stages where chapter_id=p_chapter_id and stage='TRANSLATION';
  select status='COMPLETED' into type_done from public.chapter_stages where chapter_id=p_chapter_id and stage='TYPESET';
  select status='COMPLETED' into review_done from public.chapter_stages where chapter_id=p_chapter_id and stage='REVIEW';

  if raw_done then
    for v_id in update public.chapter_stages set status='AVAILABLE'
      where chapter_id=p_chapter_id and stage in ('CLEAN_REDRAW','TRANSLATION') and status='WAITING' returning id
    loop perform public.notify_stage_available(v_id); end loop;
  end if;
  if clean_done and translation_done then
    for v_id in update public.chapter_stages set status='AVAILABLE'
      where chapter_id=p_chapter_id and stage='TYPESET' and status='WAITING' returning id
    loop perform public.notify_stage_available(v_id); end loop;
  end if;
  if type_done then
    for v_id in update public.chapter_stages set status='AVAILABLE'
      where chapter_id=p_chapter_id and stage='REVIEW' and status='WAITING' returning id
    loop perform public.notify_stage_available(v_id); end loop;
    for v_id in update public.chapter_stages set status='AVAILABLE',rejection_reason=null
      where chapter_id=p_chapter_id and stage='REVIEW' and status='REJECTED' returning id
    loop perform public.notify_stage_available(v_id, true); end loop;
  end if;
  if review_done then
    update public.chapter_stages set status='COMPLETED',completed_at=coalesce(completed_at,now())
      where chapter_id=p_chapter_id and stage='READY' and status<>'COMPLETED';
  end if;
end $$;

create or replace function public.claim_production_email_jobs(p_limit integer default 25)
returns setof public.production_email_outbox language plpgsql security definer set search_path=public as $$
begin
  return query
  with candidates as (
    select id from public.production_email_outbox
    where attempts<6 and next_attempt_at<=now()
      and (status='PENDING' or (status='PROCESSING' and locked_at<now()-interval '10 minutes'))
    order by created_at for update skip locked limit least(greatest(p_limit,1),100)
  )
  update public.production_email_outbox outbox
    set status='PROCESSING',locked_at=now(),attempts=attempts+1
    from candidates where outbox.id=candidates.id returning outbox.*;
end $$;

create or replace function public.update_catalog_chapters(p_ids uuid[], p_status public.catalog_chapter_status)
returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
  if not public.is_admin() then raise exception 'Somente administradores podem alterar o catálogo'; end if;
  if coalesce(array_length(p_ids,1),0)=0 then return 0; end if;
  perform 1 from public.work_chapter_catalog where id=any(p_ids) for update;
  if p_status='IN_PRODUCTION' then raise exception 'Em produção é controlado automaticamente pelo workflow'; end if;
  if exists(select 1 from public.work_chapter_catalog cc join public.chapters c on c.catalog_id=cc.id where cc.id=any(p_ids)) then
    raise exception 'Capítulos que já entraram em produção só podem mudar pelo workflow';
  end if;
  update public.work_chapter_catalog set status=p_status where id=any(p_ids);
  get diagnostics v_count=row_count;
  return v_count;
end $$;

create or replace function public.delete_catalog_chapters(p_ids uuid[])
returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
  if not public.is_admin() then raise exception 'Somente administradores podem remover capítulos'; end if;
  if coalesce(array_length(p_ids,1),0)=0 then return 0; end if;
  perform 1 from public.work_chapter_catalog where id=any(p_ids) for update;
  if exists(select 1 from public.work_chapter_catalog cc join public.chapters c on c.catalog_id=cc.id where cc.id=any(p_ids)) then
    raise exception 'Não é possível remover um capítulo que já entrou em produção';
  end if;
  delete from public.work_chapter_catalog where id=any(p_ids);
  get diagnostics v_count=row_count;
  return v_count;
end $$;

-- Optional asynchronous wake-up. Create Vault secrets named project_url and
-- email_worker_secret after deploying the Edge Function. Missing configuration
-- leaves jobs pending and never blocks the workflow transaction.
create or replace function public.dispatch_production_email_worker() returns void
language plpgsql security definer set search_path=public,vault,net as $$
declare v_url text; v_secret text;
begin
  begin
    select decrypted_secret into v_url from vault.decrypted_secrets where name='project_url' limit 1;
    select decrypted_secret into v_secret from vault.decrypted_secrets where name='email_worker_secret' limit 1;
    if v_url is not null and v_secret is not null then
      perform net.http_post(
        url=>rtrim(v_url,'/')||'/functions/v1/send-production-emails',
        headers=>jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_secret),
        body=>'{}'::jsonb,timeout_milliseconds=>1000
      );
    else
      update public.production_email_outbox set last_error='Worker de e-mail ainda não configurado no Vault'
        where status='PENDING' and last_error is null;
    end if;
  exception when others then
    update public.production_email_outbox set last_error='Falha ao acionar worker: '||sqlerrm
      where status='PENDING'; -- The durable outbox remains for the next attempt.
  end;
end $$;

create or replace function public.wake_production_email_worker() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  perform public.dispatch_production_email_worker();
  return new;
end $$;
create trigger production_email_outbox_wake after insert on public.production_email_outbox
  for each statement execute procedure public.wake_production_email_worker();

select cron.schedule(
  'nox-production-email-worker',
  '* * * * *',
  'select public.dispatch_production_email_worker()'
);

revoke insert,update,delete on public.production_email_outbox from anon,authenticated;
grant select on public.production_email_outbox to authenticated;
revoke execute on function public.notify_stage_available(uuid,boolean) from public,anon,authenticated;
revoke execute on function public.wake_production_email_worker() from public,anon,authenticated;
revoke execute on function public.claim_production_email_jobs(integer) from public,anon,authenticated;
revoke execute on function public.dispatch_production_email_worker() from public,anon,authenticated;
revoke execute on function public.update_catalog_chapters(uuid[],public.catalog_chapter_status) from public,anon;
revoke execute on function public.delete_catalog_chapters(uuid[]) from public,anon;
grant execute on function public.claim_production_email_jobs(integer) to service_role;
grant execute on function public.update_catalog_chapters(uuid[],public.catalog_chapter_status),public.delete_catalog_chapters(uuid[]) to authenticated;
