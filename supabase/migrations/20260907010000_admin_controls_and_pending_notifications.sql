-- Forward-only product administration. Storage providers/transfers are unchanged.
alter table public.chapters add column cancelled_at timestamptz,
  add column cancelled_by uuid references public.profiles(id);
alter table public.notifications add column archived_at timestamptz;
create index notifications_pending_idx on public.notifications(recipient_id,created_at desc)
  where read_at is null and archived_at is null;

create table public.chapter_admin_audit (
  id bigint generated always as identity primary key,
  chapter_id uuid, chapter_label text not null, action text not null,
  actor_id uuid references public.profiles(id), details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.chapter_admin_audit enable row level security;
revoke all on public.chapter_admin_audit from public,anon,authenticated;
grant select on public.chapter_admin_audit to authenticated;
create policy "admins read chapter audit" on public.chapter_admin_audit for select using(public.is_admin());

-- The inbox is a view of actionable situations, never a second activity log.
create function public.notification_is_current(n public.notifications) returns boolean
language plpgsql stable security definer set search_path=public as $$
declare s public.chapter_stages; c public.chapters; m public.staff_members;
begin
  -- API callers may inspect only their own pending situation. Maintenance SQL
  -- (no end-user subject) can still retire old rows when applying the migration.
  if auth.uid() is not null and (not public.is_active_staff() or n.recipient_id is distinct from auth.uid()) then return false; end if;
  if n.archived_at is not null then return false; end if;
  select * into m from public.staff_members where user_id=n.recipient_id;
  if not found or not m.is_active then return false; end if;
  if n.chapter_id is not null then
    select * into c from public.chapters where id=n.chapter_id;
    if not found or c.cancelled_at is not null or c.published_at is not null then return false; end if;
  end if;
  if n.kind in ('stage_available','stage_reopened','task_assigned') then
    select * into s from public.chapter_stages where id=n.chapter_stage_id;
    if not found then return false; end if;
    if not m.is_admin and not exists(select 1 from public.user_roles where user_id=m.user_id and role_code=public.required_role(s.stage)) then return false; end if;
    return case when n.kind='task_assigned' then s.status='IN_PROGRESS' and s.assigned_to=m.user_id else s.status='AVAILABLE' end;
  end if;
  if n.kind='chapter_ready' then
    return m.is_admin and exists(select 1 from public.chapter_stages where chapter_id=c.id and stage='READY' and status='COMPLETED');
  end if;
  return true;
end $$;
revoke execute on function public.notification_is_current(public.notifications) from public,anon;
grant execute on function public.notification_is_current(public.notifications) to authenticated;
drop policy "active staff own notifications" on public.notifications;
create policy "active staff own notifications" on public.notifications for select using(
  public.is_active_staff() and recipient_id=auth.uid() and archived_at is null
  and public.notification_is_current(notifications)
);

create function public.retire_stage_notifications() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  update public.notifications set archived_at=now()
    where chapter_stage_id=new.id and archived_at is null and (
      (kind in ('stage_available','stage_reopened') and (new.status<>'AVAILABLE' or old.availability_version<>new.availability_version)) or
      (kind='task_assigned' and (new.status<>'IN_PROGRESS' or recipient_id is distinct from new.assigned_to))
    );
  if new.stage='READY' and new.status<>'COMPLETED' then
    update public.notifications set archived_at=now() where chapter_id=new.chapter_id and kind='chapter_ready' and archived_at is null;
  end if;
  if new.status='IN_PROGRESS' and new.assigned_to is distinct from old.assigned_to and new.assigned_to is distinct from auth.uid() then
    insert into public.notifications(recipient_id,chapter_id,chapter_stage_id,kind,body,link_path)
      values(new.assigned_to,new.chapter_id,new.id,'task_assigned',public.chapter_label(new.chapter_id)||' foi atribuído a você.','/chapters/'||new.chapter_id);
  end if;
  -- Returning a task restores an internal pending notice, but sends no new email.
  if old.status='IN_PROGRESS' and new.status='AVAILABLE' then
    insert into public.notifications(recipient_id,chapter_id,chapter_stage_id,kind,body,link_path)
      select sm.user_id,new.chapter_id,new.id,'stage_reopened',public.chapter_label(new.chapter_id)||' está disponível novamente.','/chapters/'||new.chapter_id
      from public.staff_members sm where sm.is_active and (sm.is_admin or exists(
        select 1 from public.user_roles ur where ur.user_id=sm.user_id and ur.role_code=public.required_role(new.stage)));
  end if;
  return new;
end $$;
create trigger retire_stage_notifications after update of status,assigned_to,availability_version on public.chapter_stages
  for each row execute function public.retire_stage_notifications();
create function public.retire_chapter_notifications() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.published_at is not null or new.cancelled_at is not null then
    update public.notifications set archived_at=now() where chapter_id=new.id and archived_at is null;
  end if;
  return new;
end $$;
create trigger retire_chapter_notifications after update of published_at,cancelled_at on public.chapters
  for each row execute function public.retire_chapter_notifications();
update public.notifications n set archived_at=now() where not public.notification_is_current(n);

create or replace function public.assert_stage_dependencies(p_chapter_id uuid,p_stage public.stage_code) returns void
language plpgsql security definer set search_path=public as $$
begin
  if exists(select 1 from public.chapters where id=p_chapter_id and cancelled_at is not null) then raise exception 'Esta produção foi cancelada. Escolha o capítulo no catálogo para começar novamente.'; end if;
  if exists(select 1 from public.chapters where id=p_chapter_id and published_at is not null) then raise exception 'Este capítulo já foi publicado'; end if;
  if exists(select 1 from unnest(case p_stage
    when 'CLEAN_REDRAW' then array['RAW']::public.stage_code[] when 'TRANSLATION' then array['RAW']::public.stage_code[]
    when 'TYPESET' then array['CLEAN_REDRAW','TRANSLATION']::public.stage_code[] when 'REVIEW' then array['TYPESET']::public.stage_code[]
    else array[]::public.stage_code[] end) d where not exists(select 1 from public.chapter_stages where chapter_id=p_chapter_id and stage=d and status='COMPLETED'))
  then raise exception 'As etapas anteriores ainda não foram concluídas'; end if;
end $$;

create function public.admin_cancel_production(p_chapter_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare c public.chapters;
begin
  if not public.is_admin() then raise exception 'Somente administradores podem cancelar a produção'; end if;
  select * into c from public.chapters where id=p_chapter_id for update;
  if not found then raise exception 'Capítulo não encontrado'; end if;
  if c.cancelled_at is not null then return; end if;
  if c.published_at is not null then raise exception 'Despublique o capítulo antes de cancelar a produção'; end if;
  update public.chapters set cancelled_at=now(),cancelled_by=auth.uid() where id=c.id;
  update public.stage_assignments set ended_at=now(),released_at=now() where ended_at is null and chapter_stage_id in(select id from public.chapter_stages where chapter_id=c.id);
  update public.chapter_stages set status='WAITING',assigned_to=null,assigned_at=null,completed_at=null,rejection_reason=null where chapter_id=c.id;
  update public.artifacts set is_current=false,superseded_at=coalesce(superseded_at,now()),upload_status=case when upload_status='PENDING' then 'FAILED' else upload_status end where chapter_id=c.id;
  update public.production_email_outbox set status='CANCELLED',locked_at=null,last_error=null where chapter_id=c.id and status in ('PENDING','PROCESSING','FAILED');
  update public.work_chapter_catalog set status='TODO' where id=c.catalog_id;
  perform public.add_activity(c.id,'production_cancelled',null);
  insert into public.chapter_admin_audit(chapter_id,chapter_label,action,actor_id) values(c.id,public.chapter_label(c.id),'cancelled',auth.uid());
end $$;

create or replace function public.start_catalog_production(p_catalog_id uuid) returns public.chapters
language plpgsql security definer set search_path=public as $$
declare cc public.work_chapter_catalog; c public.chapters; raw_id uuid;
begin
  if not public.has_role('RAW_PROVIDER') then raise exception 'O cargo Raw Provider é necessário'; end if;
  select * into cc from public.work_chapter_catalog where id=p_catalog_id for update;
  if not found then raise exception 'Capítulo não encontrado no catálogo'; end if;
  if cc.status<>'TODO' then raise exception 'Este capítulo acabou de entrar em produção por outro membro'; end if;
  insert into public.chapters(work_id,number,catalog_id,created_by) values(cc.work_id,cc.number::text,cc.id,auth.uid())
    on conflict(work_id,number) do update set catalog_id=coalesce(public.chapters.catalog_id,excluded.catalog_id) returning * into c;
  if c.cancelled_at is not null then
    update public.chapters set cancelled_at=null,cancelled_by=null where id=c.id returning * into c;
    update public.chapter_stages set status='AVAILABLE' where chapter_id=c.id and stage='RAW';
  end if;
  select id into raw_id from public.chapter_stages where chapter_id=c.id and stage='RAW' and status='AVAILABLE' for update;
  if not found then raise exception 'RAW já foi assumido'; end if;
  update public.work_chapter_catalog set status='IN_PRODUCTION' where id=cc.id;
  update public.chapter_stages set status='IN_PROGRESS',assigned_to=auth.uid(),assigned_at=now() where id=raw_id;
  insert into public.stage_assignments(chapter_stage_id,user_id,assigned_by) values(raw_id,auth.uid(),auth.uid());
  update public.notifications set archived_at=now() where chapter_stage_id=raw_id and archived_at is null;
  perform public.add_activity(c.id,'production_started','RAW',jsonb_build_object('catalog_id',cc.id));
  return c;
end $$;

create function public.admin_unpublish_chapter(p_chapter_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare c public.chapters;
begin
  if not public.is_admin() then raise exception 'Somente administradores podem despublicar'; end if;
  select * into c from public.chapters where id=p_chapter_id for update;
  if not found then raise exception 'Capítulo não encontrado'; end if;
  if c.published_at is null then return; end if;
  update public.chapters set published_at=null,published_by=null where id=c.id;
  insert into public.notifications(recipient_id,chapter_id,kind,body,link_path)
    select user_id,c.id,'chapter_ready',public.chapter_label(c.id)||' voltou para Pra upar.','/chapters/'||c.id from public.staff_members where is_active and is_admin;
  perform public.add_activity(c.id,'unpublished','READY');
end $$;

create or replace function public.admin_assign_stage(p_stage_id uuid,p_assignee uuid) returns public.chapter_stages
language plpgsql security definer set search_path=public as $$
declare s public.chapter_stages;
begin
  if not public.is_admin() then raise exception 'Somente administradores podem reatribuir tarefas'; end if;
  perform public.lock_stage_chapter(p_stage_id);
  select * into s from public.chapter_stages where id=p_stage_id for update;
  if not found or s.stage='READY' then raise exception 'Escolha uma etapa de trabalho'; end if;
  perform public.assert_stage_dependencies(s.chapter_id,s.stage);
  if s.status not in ('AVAILABLE','IN_PROGRESS') then raise exception 'Reabra a etapa antes de atribuir uma pessoa'; end if;
  if p_assignee is null then
    if s.status='IN_PROGRESS' then return public.release_stage(s.id); end if;
    return s;
  end if;
  if not exists(select 1 from public.staff_members m where m.user_id=p_assignee and m.is_active and (m.is_admin or exists(
    select 1 from public.user_roles r where r.user_id=m.user_id and r.role_code=public.required_role(s.stage)))) then raise exception 'Escolha um membro ativo com o cargo desta etapa'; end if;
  if s.assigned_to=p_assignee and s.status='IN_PROGRESS' then return s; end if;
  update public.stage_assignments set ended_at=now(),released_at=now() where chapter_stage_id=s.id and ended_at is null;
  update public.artifacts set is_current=false,superseded_at=coalesce(superseded_at,now()),upload_status=case when upload_status='PENDING' then 'FAILED' else upload_status end where chapter_id=s.chapter_id and stage=s.stage;
  update public.chapter_stages set status='IN_PROGRESS',assigned_to=p_assignee,assigned_at=now() where id=s.id returning * into s;
  insert into public.stage_assignments(chapter_stage_id,user_id,assigned_by) values(s.id,p_assignee,auth.uid());
  perform public.add_activity(s.chapter_id,'reassigned',s.stage,jsonb_build_object('assignee',p_assignee));
  return s;
end $$;

create function public.admin_reopen_stage(p_stage_id uuid,p_reason text) returns void
language plpgsql security definer set search_path=public as $$
declare s public.chapter_stages; affected public.stage_code[]; target uuid;
begin
  if not public.is_admin() then raise exception 'Somente administradores podem reabrir etapas'; end if;
  if coalesce(trim(p_reason),'')='' then raise exception 'Explique por que a etapa será reaberta'; end if;
  perform public.lock_stage_chapter(p_stage_id);
  select * into s from public.chapter_stages where id=p_stage_id for update;
  if not found or s.stage='READY' then raise exception 'Escolha uma etapa de trabalho'; end if;
  if exists(select 1 from public.chapters where id=s.chapter_id and (published_at is not null or cancelled_at is not null)) then raise exception 'Despublique o capítulo ou reinicie a produção antes de reabrir uma etapa'; end if;
  affected:=case s.stage when 'RAW' then array['RAW','CLEAN_REDRAW','TRANSLATION','TYPESET','REVIEW','READY']::public.stage_code[]
    when 'CLEAN_REDRAW' then array['CLEAN_REDRAW','TYPESET','REVIEW','READY']::public.stage_code[]
    when 'TRANSLATION' then array['TRANSLATION','TYPESET','REVIEW','READY']::public.stage_code[]
    when 'TYPESET' then array['TYPESET','REVIEW','READY']::public.stage_code[] else array['REVIEW','READY']::public.stage_code[] end;
  update public.stage_assignments set ended_at=now(),released_at=now() where ended_at is null and chapter_stage_id in(select id from public.chapter_stages where chapter_id=s.chapter_id and stage=any(affected));
  update public.chapter_stages set status='WAITING',assigned_to=null,assigned_at=null,completed_at=null,rejection_reason=null where chapter_id=s.chapter_id and stage=any(affected);
  update public.chapter_stages set rejection_reason=trim(p_reason) where id=s.id;
  update public.artifacts set is_current=false,superseded_at=coalesce(superseded_at,now()),upload_status=case when upload_status='PENDING' then 'FAILED' else upload_status end where chapter_id=s.chapter_id and stage=any(affected);
  update public.work_chapter_catalog set status='IN_PRODUCTION' where id=(select catalog_id from public.chapters where id=s.chapter_id);
  if s.stage='RAW' then
    update public.chapter_stages set status='AVAILABLE' where id=s.id returning id into target;
    perform public.notify_stage_available(target,true);
  else perform public.refresh_chapter_workflow(s.chapter_id); end if;
  perform public.add_activity(s.chapter_id,'stage_reopened_by_admin',s.stage,jsonb_build_object('reason',trim(p_reason)));
end $$;

create function public.admin_delete_chapter(p_chapter_id uuid,p_confirmation text) returns void
language plpgsql security definer set search_path=public as $$
declare c public.chapters; label text;
begin
  if not public.is_admin() then raise exception 'Somente administradores podem excluir capítulos'; end if;
  select * into c from public.chapters where id=p_chapter_id for update;
  if not found then raise exception 'Capítulo não encontrado'; end if;
  label:=public.chapter_label(c.id);
  if p_confirmation is distinct from label then raise exception 'Digite o nome completo do capítulo para confirmar'; end if;
  insert into public.chapter_admin_audit(chapter_id,chapter_label,action,actor_id,details)
    values(c.id,label,'deleted',auth.uid(),jsonb_build_object('catalog_id',c.catalog_id,'artifacts',(select count(*) from public.artifacts where chapter_id=c.id)));
  -- External stored files are not deleted. This operation concerns the chapter's database records.
  delete from public.chapters where id=c.id;
  delete from public.work_chapter_catalog where id=c.catalog_id;
end $$;

create function public.admin_delete_catalog_chapters(p_ids uuid[],p_confirmation text) returns integer
language plpgsql security definer set search_path=public as $$
declare c record; total integer;
begin
  if not public.is_admin() then raise exception 'Somente administradores podem excluir capítulos'; end if;
  if p_confirmation is distinct from 'EXCLUIR' then raise exception 'Digite EXCLUIR para confirmar'; end if;
  if coalesce(array_length(p_ids,1),0)>100 then raise exception 'Selecione até 100 capítulos por vez'; end if;
  select count(*) into total from public.work_chapter_catalog where id=any(p_ids);
  for c in select id from public.chapters where catalog_id=any(p_ids) order by id for update loop
    perform public.admin_delete_chapter(c.id,public.chapter_label(c.id));
  end loop;
  delete from public.work_chapter_catalog where id=any(p_ids);
  return total;
end $$;

create or replace function public.update_catalog_chapters(p_ids uuid[],p_status public.catalog_chapter_status) returns integer
language plpgsql security definer set search_path=public as $$
declare total integer;
begin
  if not public.is_admin() then raise exception 'Somente administradores podem alterar o catálogo'; end if;
  if p_status is null or p_status='IN_PRODUCTION' then raise exception 'A produção começa quando alguém pega o capítulo'; end if;
  perform 1 from public.work_chapter_catalog where id=any(p_ids) order by id for update;
  if exists(select 1 from public.chapters where catalog_id=any(p_ids) and cancelled_at is null) then raise exception 'Cancele a produção antes de alterar o status do catálogo'; end if;
  update public.work_chapter_catalog set status=p_status where id=any(p_ids);
  get diagnostics total=row_count;
  return total;
end $$;

revoke execute on function public.retire_stage_notifications(),public.retire_chapter_notifications(),
  public.admin_cancel_production(uuid),public.admin_unpublish_chapter(uuid),public.admin_assign_stage(uuid,uuid),
  public.admin_reopen_stage(uuid,text),public.admin_delete_chapter(uuid,text),public.admin_delete_catalog_chapters(uuid[],text)
  from public,anon,authenticated;
grant execute on function public.admin_cancel_production(uuid),public.admin_unpublish_chapter(uuid),public.admin_assign_stage(uuid,uuid),
  public.admin_reopen_stage(uuid,text),public.admin_delete_chapter(uuid,text),public.admin_delete_catalog_chapters(uuid[],text) to authenticated;
