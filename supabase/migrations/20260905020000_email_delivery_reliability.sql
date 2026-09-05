alter table public.production_email_outbox add column first_attempt_at timestamptz;
create table public.email_worker_diagnostics(
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  message text not null,
  request_id bigint
);
alter table public.email_worker_diagnostics enable row level security;
create policy "admin email diagnostics" on public.email_worker_diagnostics for select using(public.is_admin());
revoke all on public.email_worker_diagnostics from anon,authenticated;
grant select on public.email_worker_diagnostics to authenticated;

create or replace function public.notify_stage_available(p_stage_id uuid,p_reopened boolean default false) returns void
language plpgsql security definer set search_path=public as $$
declare s public.chapter_stages; v_role public.role_code; v_title text; v_number text; v_version integer;
begin
  select * into s from public.chapter_stages where id=p_stage_id for update;
  if not found or s.stage='READY' or s.status<>'AVAILABLE' then return; end if;
  update public.chapter_stages set availability_version=availability_version+1 where id=s.id returning availability_version into v_version;
  v_role := public.required_role(s.stage);
  select w.title,c.number into v_title,v_number from public.chapters c join public.works w on w.id=c.work_id where c.id=s.chapter_id;
  insert into public.notifications(recipient_id,chapter_id,chapter_stage_id,kind,body,link_path)
    select distinct sm.user_id,s.chapter_id,s.id,case when p_reopened then 'stage_reopened' else 'stage_available' end,
      v_title||' #'||v_number||' — novo trabalho disponível.','/chapters/'||s.chapter_id
    from public.staff_members sm left join public.user_roles ur on ur.user_id=sm.user_id
    where sm.is_active and (sm.is_admin or ur.role_code=v_role);
  if s.stage<>'RAW' then
    begin
      insert into public.production_email_outbox(chapter_stage_id,chapter_id,availability_version,recipient_id,recipient_email,work_title,chapter_number,stage)
        select s.id,s.chapter_id,v_version,sm.user_id,u.email,v_title,v_number,s.stage
        from public.staff_members sm join public.user_roles ur on ur.user_id=sm.user_id and ur.role_code=v_role
        join auth.users u on u.id=sm.user_id where sm.is_active and coalesce(trim(u.email),'')<>''
        on conflict(chapter_stage_id,availability_version,recipient_id) do nothing;
    exception when others then
      insert into public.email_worker_diagnostics(message) values('Falha ao preparar avisos: '||sqlerrm);
    end;
  end if;
  perform public.add_activity(s.chapter_id,'stage_available',s.stage);
end $$;

create or replace function public.claim_production_email_jobs(p_limit integer default 25)
returns setof public.production_email_outbox language plpgsql security definer set search_path=public as $$
begin
  -- Never automatically resend an ambiguous delivery after the provider's
  -- 24-hour idempotency window; leave it for diagnosis instead.
  update public.production_email_outbox o set status='FAILED',locked_at=null,
    last_error=case when first_attempt_at<now()-interval '23 hours' then 'Prazo de retentativa encerrado; conferir entrega antes de reenviar'
      when attempts>=6 then 'Limite de tentativas atingido' else 'Aviso cancelado: cargo/acesso removido ou etapa já assumida' end
    where (status='PENDING' or (status='PROCESSING' and locked_at<now()-interval '10 minutes')) and (
      attempts>=6 or first_attempt_at<now()-interval '23 hours' or
      not exists(select 1 from public.staff_members sm join public.user_roles ur on ur.user_id=sm.user_id
        where sm.user_id=o.recipient_id and sm.is_active and ur.role_code=public.required_role(o.stage)) or
      not exists(select 1 from public.chapter_stages s where s.id=o.chapter_stage_id and s.status='AVAILABLE' and s.availability_version=o.availability_version)
    );
  return query
  with candidates as (
    select id from public.production_email_outbox where next_attempt_at<=now() and attempts<6
      and (status='PENDING' or (status='PROCESSING' and locked_at<now()-interval '10 minutes'))
    order by created_at for update skip locked limit least(greatest(p_limit,1),25)
  )
  update public.production_email_outbox o set status='PROCESSING',locked_at=now(),attempts=attempts+1,
    first_attempt_at=coalesce(first_attempt_at,now()) from candidates where o.id=candidates.id returning o.*;
end $$;

create or replace function public.dispatch_production_email_worker() returns void
language plpgsql security definer set search_path=public as $$
declare v_url text; v_secret text; v_request bigint; v_last record;
begin
  if not pg_try_advisory_xact_lock(710044) then return; end if;
  if not exists(select 1 from public.production_email_outbox where status in ('PENDING','PROCESSING')) then return; end if;
  -- Capture HTTP/auth/deployment errors that occur AFTER the database commits.
  select r.status_code,r.error_msg into v_last from net._http_response r
    join public.email_worker_diagnostics d on d.request_id=r.id order by r.id desc limit 1;
  if v_last.status_code>=400 or v_last.error_msg is not null then
    update public.production_email_outbox set last_error='Worker HTTP '||coalesce(v_last.status_code::text,'timeout')||': '||coalesce(v_last.error_msg,'Confira deploy e autenticação da função')
      where status='PENDING' and attempts=0;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name='project_url' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name='email_worker_secret' limit 1;
  if coalesce(v_url,'')='' or coalesce(v_secret,'')='' then
    update public.production_email_outbox set last_error='Configure project_url e email_worker_secret no Vault' where status='PENDING' and attempts=0;
    return;
  end if;
  perform 1 from public.email_worker_diagnostics where created_at>now()-interval '45 seconds' and request_id is not null;
  if found then return; end if;
  select net.http_post(url=>rtrim(v_url,'/')||'/functions/v1/send-production-emails',
    headers=>jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_secret),
    body=>'{}'::jsonb,timeout_milliseconds=>30000) into v_request;
  insert into public.email_worker_diagnostics(message,request_id) values('Worker acionado',v_request);
exception when others then
  insert into public.email_worker_diagnostics(message) values('Falha ao acionar worker: '||sqlerrm);
end $$;

revoke execute on function public.notify_stage_available(uuid,boolean),public.claim_production_email_jobs(integer),public.dispatch_production_email_worker() from public,anon,authenticated;
grant execute on function public.claim_production_email_jobs(integer) to service_role;
