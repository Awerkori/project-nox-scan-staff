-- Forward-only repair. No existing production data or applied migration is removed.

-- OAuth insertion only creates a profile. Invite handling belongs after the
-- provider identity has been committed, not inside the auth.users INSERT.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  insert into public.profiles(id,display_name,avatar_url)
  values(new.id,new.raw_user_meta_data->>'full_name',new.raw_user_meta_data->>'avatar_url')
  on conflict(id) do nothing;
  return new;
end $$;

create or replace function public.claim_staff_invite() returns public.staff_members
language plpgsql security definer set search_path=public as $$
declare v_identity jsonb; v_login text; v_invite public.staff_invites; v_member public.staff_members;
begin
  if auth.uid() is null then raise exception 'Entre com sua conta GitHub'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,710043));
  select identity_data into v_identity from auth.identities
    where user_id=auth.uid() and provider='github' order by updated_at desc limit 1;
  v_login := lower(coalesce(v_identity->>'user_name',v_identity->>'preferred_username',v_identity->>'login'));
  if coalesce(v_login,'')='' then raise exception 'Não foi possível confirmar sua identidade GitHub. Entre novamente.'; end if;
  select * into v_member from public.staff_members where user_id=auth.uid();
  if found then
    if not v_member.is_active then raise exception 'Seu acesso está desativado. Fale com um administrador.'; end if;
    return v_member;
  end if;
  insert into public.profiles(id,github_login,display_name,avatar_url)
    values(auth.uid(),v_login,coalesce(v_identity->>'full_name',v_identity->>'name',v_login),v_identity->>'avatar_url')
    on conflict(id) do update set github_login=excluded.github_login,display_name=excluded.display_name,avatar_url=excluded.avatar_url;
  select * into v_invite from public.staff_invites
    where lower(github_login)=v_login and is_active order by created_at limit 1 for update;
  if not found then raise exception 'Esta conta GitHub ainda não foi convidada para a staff.'; end if;
  insert into public.staff_members(user_id,github_login,display_name,is_admin,is_active)
    values(auth.uid(),v_login,coalesce(v_invite.display_name,v_identity->>'full_name',v_login),v_invite.is_admin,true)
    returning * into v_member;
  insert into public.user_roles(user_id,role_code)
    select auth.uid(),r from unnest(v_invite.roles) r where r<>'ADMIN' on conflict do nothing;
  delete from public.staff_invites where lower(github_login)=v_login;
  return v_member;
end $$;

create or replace function public.protect_last_admin() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if old.is_active and old.is_admin and
    (tg_op='DELETE' or not new.is_active or not new.is_admin) then
    perform pg_advisory_xact_lock(710042);
    if not exists(select 1 from public.staff_members where user_id<>old.user_id and is_active and is_admin) then
      raise exception 'O último administrador ativo não pode ser removido ou desativado';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

-- Serialize every workflow mutation on its chapter before taking stage locks.
-- This also resolves Clean+Translation completing simultaneously and each
-- missing the other's completion under READ COMMITTED.
create or replace function public.lock_stage_chapter(p_stage_id uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  perform 1 from public.chapters where id=(select chapter_id from public.chapter_stages where id=p_stage_id) for update;
end $$;

create or replace function public.assert_stage_dependencies(p_chapter_id uuid,p_stage public.stage_code) returns void
language plpgsql security definer set search_path=public as $$
begin
  if exists(select 1 from public.chapters where id=p_chapter_id and published_at is not null) then
    raise exception 'Este capítulo já foi publicado';
  end if;
  if exists(
    select 1 from unnest(case p_stage
      when 'CLEAN_REDRAW' then array['RAW']::public.stage_code[]
      when 'TRANSLATION' then array['RAW']::public.stage_code[]
      when 'TYPESET' then array['CLEAN_REDRAW','TRANSLATION']::public.stage_code[]
      when 'REVIEW' then array['TYPESET']::public.stage_code[]
      else array[]::public.stage_code[] end) d
    where not exists(select 1 from public.chapter_stages where chapter_id=p_chapter_id and stage=d and status='COMPLETED')
  ) then raise exception 'As etapas anteriores ainda não foram concluídas'; end if;
end $$;

create or replace function public.claim_stage(p_stage_id uuid) returns public.chapter_stages
language plpgsql security definer set search_path=public as $$
declare s public.chapter_stages;
begin
  perform public.lock_stage_chapter(p_stage_id);
  select * into s from public.chapter_stages where id=p_stage_id for update;
  if not found or s.stage='READY' or not public.has_role(public.required_role(s.stage)) then raise exception 'Seu cargo não permite assumir esta etapa'; end if;
  perform public.assert_stage_dependencies(s.chapter_id,s.stage);
  if s.status<>'AVAILABLE' then raise exception 'Este capítulo acabou de ser assumido por outro membro.'; end if;
  update public.chapter_stages set status='IN_PROGRESS',assigned_to=auth.uid(),assigned_at=now() where id=s.id returning * into s;
  insert into public.stage_assignments(chapter_stage_id,user_id,assigned_by) values(s.id,auth.uid(),auth.uid());
  perform public.add_activity(s.chapter_id,'claimed',s.stage);
  return s;
end $$;

create or replace function public.release_stage(p_stage_id uuid) returns public.chapter_stages
language plpgsql security definer set search_path=public as $$
declare s public.chapter_stages;
begin
  perform public.lock_stage_chapter(p_stage_id);
  select * into s from public.chapter_stages where id=p_stage_id for update;
  if not found or not public.has_role(public.required_role(s.stage)) or
    (s.assigned_to is distinct from auth.uid() and not public.is_admin()) or s.status<>'IN_PROGRESS' then
    raise exception 'Você não pode devolver esta etapa';
  end if;
  update public.chapter_stages set status='AVAILABLE',assigned_to=null,assigned_at=null where id=s.id returning * into s;
  update public.artifacts set upload_status='FAILED' where chapter_id=s.chapter_id and stage=s.stage and upload_status='PENDING';
  update public.stage_assignments set ended_at=now(),released_at=now() where chapter_stage_id=s.id and ended_at is null;
  perform public.add_activity(s.chapter_id,'released',s.stage);
  -- A release is not new work: preserve the same email availability generation.
  return s;
end $$;

create or replace function public.complete_stage(p_stage_id uuid,p_note text default null) returns public.chapter_stages
language plpgsql security definer set search_path=public as $$
declare s public.chapter_stages; v_artifact uuid;
begin
  perform public.lock_stage_chapter(p_stage_id);
  select * into s from public.chapter_stages where id=p_stage_id for update;
  if not found or not public.has_role(public.required_role(s.stage)) or
    (s.assigned_to is distinct from auth.uid() and not public.is_admin()) or
    s.status<>'IN_PROGRESS' or s.stage in ('REVIEW','READY') then raise exception 'Você não pode concluir esta etapa'; end if;
  perform public.assert_stage_dependencies(s.chapter_id,s.stage);
  select id into v_artifact from public.artifacts where chapter_id=s.chapter_id and stage=s.stage and upload_status='AVAILABLE' and is_current order by version desc limit 1;
  if v_artifact is null then raise exception 'Envie um arquivo antes de concluir'; end if;
  update public.chapter_stages set status='COMPLETED',completed_at=now(),rejection_reason=null where id=s.id returning * into s;
  update public.stage_assignments set ended_at=now() where chapter_stage_id=s.id and ended_at is null;
  insert into public.stage_completions(chapter_stage_id,chapter_id,stage,user_id,artifact_id,note)
    values(s.id,s.chapter_id,s.stage,auth.uid(),v_artifact,p_note);
  perform public.add_activity(s.chapter_id,'completed',s.stage,jsonb_build_object('artifact_id',v_artifact));
  perform public.refresh_chapter_workflow(s.chapter_id);
  return s;
end $$;

create or replace function public.reserve_artifact_upload(
  p_chapter_id uuid, p_stage public.stage_code, p_original_name text,
  p_mime_type text, p_byte_size bigint, p_note text default null
) returns public.artifacts language plpgsql security definer set search_path=public as $$
declare v_stage public.chapter_stages; v_artifact public.artifacts; v_version integer; v_ext text;
begin
  perform 1 from public.chapters where id=p_chapter_id for update;
  perform public.assert_stage_dependencies(p_chapter_id,p_stage);
  select * into v_stage from public.chapter_stages where chapter_id=p_chapter_id and stage=p_stage for update;
  if not found or not public.has_role(public.required_role(p_stage)) or (v_stage.assigned_to is distinct from auth.uid() and not public.is_admin()) or v_stage.status<>'IN_PROGRESS' then
    raise exception 'Você não pode enviar arquivos para esta etapa';
  end if;
  if p_stage in ('REVIEW','READY') then raise exception 'Esta etapa não recebe arquivos'; end if;
  if p_byte_size is null or p_byte_size<=0 or p_byte_size>1073741824 then raise exception 'Arquivo inválido ou maior que 1 GB'; end if;
  if coalesce(trim(p_original_name),'')='' then raise exception 'Escolha um arquivo'; end if;
  select coalesce(max(version),0)+1 into v_version from public.artifacts where chapter_id=p_chapter_id and stage=p_stage;
  v_ext := case lower(coalesce(p_mime_type,'')) when 'application/zip' then '.zip' when 'application/pdf' then '.pdf'
    when 'image/jpeg' then '.jpg' when 'image/png' then '.png' when 'image/webp' then '.webp' else '.bin' end;
  insert into public.artifacts(chapter_id,stage,provider,provider_key,original_name,mime_type,byte_size,version,uploaded_by,note,upload_status,is_current)
    values(p_chapter_id,p_stage,'supabase',p_chapter_id::text||'/'||lower(p_stage::text)||'/v'||v_version||'/'||gen_random_uuid()::text||v_ext,
      left(p_original_name,255),p_mime_type,p_byte_size,v_version,auth.uid(),p_note,'PENDING',false) returning * into v_artifact;
  return v_artifact;
end $$;

create or replace function public.finalize_artifact_upload(p_artifact_id uuid) returns public.artifacts
language plpgsql security definer set search_path=public as $$
declare a public.artifacts; s public.chapter_stages;
begin
  select * into a from public.artifacts where id=p_artifact_id;
  perform 1 from public.chapters where id=a.chapter_id for update;
  select * into s from public.chapter_stages where chapter_id=a.chapter_id and stage=a.stage for update;
  select * into a from public.artifacts where id=p_artifact_id for update;
  if a.id is null or not public.has_role(public.required_role(a.stage)) or
    (s.assigned_to is distinct from auth.uid() and not public.is_admin()) or
    (a.uploaded_by is distinct from auth.uid() and not public.is_admin()) or
    s.status<>'IN_PROGRESS' or a.upload_status<>'PENDING' then raise exception 'Upload inválido para esta etapa'; end if;
  perform public.assert_stage_dependencies(a.chapter_id,a.stage);
  if not exists(select 1 from storage.objects where bucket_id='scan-artifacts' and name=a.provider_key
    and (metadata->>'size')::bigint=a.byte_size) then raise exception 'O arquivo ainda não terminou de enviar'; end if;
  update public.artifacts set upload_status='AVAILABLE' where id=a.id;
  update public.artifacts set is_current=false,superseded_at=coalesce(superseded_at,now()) where chapter_id=a.chapter_id and stage=a.stage and is_current;
  update public.artifacts set is_current=true,superseded_at=null where id=(
    select id from public.artifacts where chapter_id=a.chapter_id and stage=a.stage and upload_status='AVAILABLE'
      and created_at>=coalesce(s.assigned_at,'epoch') order by version desc limit 1
  );
  perform public.add_activity(a.chapter_id,'uploaded',a.stage,jsonb_build_object('artifact_id',a.id,'version',a.version));
  select * into a from public.artifacts where id=p_artifact_id;
  return a;
end $$;

-- Existing QC implementation, with chapter locking and invalidation on ALL
-- affected stages. Keep historical artifacts and contributions intact.
create or replace function public.review_chapter(p_stage_id uuid,p_approved boolean,p_reason text default null,p_return_stage public.stage_code default null) returns void
language plpgsql security definer set search_path=public as $$
declare s public.chapter_stages; v_artifact uuid; v_target uuid;
begin
  perform public.lock_stage_chapter(p_stage_id);
  select * into s from public.chapter_stages where id=p_stage_id for update;
  if not found or s.stage<>'REVIEW' or not public.has_role('REVIEWER_QC') or
    (s.assigned_to is distinct from auth.uid() and not public.is_admin()) or s.status<>'IN_PROGRESS' then raise exception 'Você não pode revisar este capítulo'; end if;
  perform public.assert_stage_dependencies(s.chapter_id,'REVIEW');
  if p_approved is null then raise exception 'Escolha uma decisão'; end if;
  if not p_approved and (coalesce(trim(p_reason),'')='' or p_return_stage is null or p_return_stage not in ('CLEAN_REDRAW','TRANSLATION','TYPESET')) then raise exception 'Informe o motivo e para qual etapa devolver'; end if;
  update public.stage_assignments set ended_at=now() where chapter_stage_id=s.id and ended_at is null;
  if p_approved then
    select id into v_artifact from public.artifacts where chapter_id=s.chapter_id and stage='TYPESET' and is_current and upload_status='AVAILABLE';
    if v_artifact is null then raise exception 'Não existe Type válido para aprovar'; end if;
    update public.chapter_stages set status='COMPLETED',completed_at=now(),rejection_reason=null where chapter_id=s.chapter_id and stage in ('REVIEW','READY');
    insert into public.stage_completions(chapter_stage_id,chapter_id,stage,user_id,artifact_id) values(s.id,s.chapter_id,'REVIEW',auth.uid(),v_artifact);
    update public.work_chapter_catalog set status='COMPLETED' where id=(select catalog_id from public.chapters where id=s.chapter_id);
    insert into public.notifications(recipient_id,chapter_id,kind,body,link_path)
      select user_id,s.chapter_id,'chapter_ready',public.chapter_label(s.chapter_id)||' está pronto pra upar.','/chapters/'||s.chapter_id
      from public.staff_members where is_active and is_admin;
    perform public.add_activity(s.chapter_id,'approved','REVIEW');
  else
    update public.chapter_stages set status='WAITING',assigned_to=null,assigned_at=null,completed_at=null,rejection_reason=null
      where chapter_id=s.chapter_id and stage in ('TYPESET','REVIEW','READY');
    update public.chapter_stages set status='AVAILABLE',assigned_to=null,assigned_at=null,completed_at=null,rejection_reason=p_reason
      where chapter_id=s.chapter_id and stage=p_return_stage returning id into v_target;
    update public.artifacts set is_current=false,superseded_at=now()
      where chapter_id=s.chapter_id and stage in ('TYPESET',p_return_stage) and is_current;
    update public.artifacts set upload_status='FAILED' where chapter_id=s.chapter_id and stage in ('TYPESET',p_return_stage) and upload_status='PENDING';
    perform public.add_activity(s.chapter_id,'rejected','REVIEW',jsonb_build_object('reason',p_reason,'return_stage',p_return_stage));
    perform public.notify_stage_available(v_target,true);
  end if;
end $$;

-- Browser writes must use the validated operations above.
drop policy if exists "admin manage chapters" on public.chapters;
drop policy if exists "admin delete work catalog" on public.work_chapter_catalog;
drop policy if exists "assigned staff upload scan artifacts" on storage.objects;
create policy "reserved staff artifact uploads" on storage.objects for insert with check(
  bucket_id='scan-artifacts' and exists(
    select 1 from public.artifacts a join public.chapter_stages s on s.chapter_id=a.chapter_id and s.stage=a.stage
    where a.provider_key=name and a.provider='supabase' and a.upload_status='PENDING' and a.uploaded_by=auth.uid()
      and s.status='IN_PROGRESS' and (s.assigned_to=auth.uid() or public.is_admin()) and public.has_role(public.required_role(s.stage))
  )
);

-- SECURITY DEFINER internals must never be callable through the public API.
do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef and p.proname in (
      'is_admin','is_active_staff','has_role','handle_new_user','claim_staff_invite','protect_last_admin',
      'lock_stage_chapter','assert_stage_dependencies','claim_stage','release_stage','complete_stage','review_chapter',
      'reserve_artifact_upload','finalize_artifact_upload','start_catalog_production','mark_chapter_published',
      'add_catalog_chapter_range','set_catalog_chapter_status_range','update_catalog_chapters','delete_catalog_chapters',
      'notify_stage_available','refresh_chapter_workflow','initialize_chapter_stages','add_activity','chapter_label',
      'admin_assign_stage','create_chapter_range','register_artifact','claim_production_email_jobs','dispatch_production_email_worker','wake_production_email_worker')
  loop execute format('revoke execute on function %s from public,anon,authenticated',f.signature); end loop;
end $$;
grant execute on function public.is_admin(),public.is_active_staff(),public.has_role(public.role_code),
  public.claim_staff_invite(),public.start_catalog_production(uuid),public.claim_stage(uuid),public.release_stage(uuid),
  public.complete_stage(uuid,text),public.review_chapter(uuid,boolean,text,public.stage_code),
  public.reserve_artifact_upload(uuid,public.stage_code,text,text,bigint,text),public.finalize_artifact_upload(uuid),
  public.add_catalog_chapter_range(uuid,integer,integer),public.update_catalog_chapters(uuid[],public.catalog_chapter_status),
  public.delete_catalog_chapters(uuid[]),public.mark_chapter_published(uuid) to authenticated;
grant execute on function public.claim_production_email_jobs(integer) to service_role;

drop policy if exists "staff read notifications" on public.notifications;
create policy "active staff own notifications" on public.notifications for select using(public.is_active_staff() and recipient_id=auth.uid());
drop policy if exists "staff update own notifications" on public.notifications;
create policy "active staff mark notifications" on public.notifications for update using(public.is_active_staff() and recipient_id=auth.uid()) with check(public.is_active_staff() and recipient_id=auth.uid());
revoke update on public.notifications from authenticated;
grant update(read_at) on public.notifications to authenticated;
do $$ begin alter publication supabase_realtime add table public.chapters; exception when duplicate_object then null; end $$;
