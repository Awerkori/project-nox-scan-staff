-- Production integrity: catalog-to-production, durable credits, versioned uploads,
-- rejection dependency invalidation, private covers, invitations and admin safety.

alter table public.chapters add column catalog_id uuid references public.work_chapter_catalog(id);
update public.chapters c set catalog_id=cc.id
from public.work_chapter_catalog cc
where cc.work_id=c.work_id and c.number ~ '^[0-9]+$' and cc.number=c.number::integer;
create unique index chapters_catalog_id_unique on public.chapters(catalog_id) where catalog_id is not null;

alter table public.artifacts add column upload_status text not null default 'AVAILABLE'
  check (upload_status in ('PENDING','AVAILABLE','FAILED'));
alter table public.artifacts add column is_current boolean not null default true;
alter table public.artifacts add column superseded_at timestamptz;

create table public.stage_completions (
  id uuid primary key default gen_random_uuid(),
  chapter_stage_id uuid not null references public.chapter_stages(id) on delete cascade,
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  stage public.stage_code not null,
  user_id uuid not null references public.profiles(id),
  artifact_id uuid references public.artifacts(id),
  note text,
  completed_at timestamptz not null default now()
);
create index stage_completions_chapter_idx on public.stage_completions(chapter_id, completed_at);
create index activity_log_chapter_created_idx on public.activity_log(chapter_id, created_at desc);

create or replace function public.has_role(p_role public.role_code) returns boolean language sql stable security definer set search_path=public as $$
  select public.is_active_staff() and (public.is_admin() or exists(select 1 from public.user_roles where user_id=auth.uid() and role_code=p_role))
$$;

drop policy if exists "admin manage work catalog" on public.work_chapter_catalog;
create policy "admin insert work catalog" on public.work_chapter_catalog for insert with check(public.is_admin());
create policy "admin delete work catalog" on public.work_chapter_catalog for delete using(public.is_admin());

alter table public.stage_completions enable row level security;
create policy "staff read stage completions" on public.stage_completions for select using (public.is_active_staff());

-- The check and mutation serialize globally so concurrent admin removals cannot
-- both observe another administrator and leave the project unmanageable.
create or replace function public.protect_last_admin() returns trigger language plpgsql security definer set search_path=public as $$
begin
  perform pg_advisory_xact_lock(710042);
  if tg_op='DELETE' or (old.is_active and old.is_admin and (not new.is_active or not new.is_admin)) then
    if not exists(select 1 from public.staff_members sm where sm.user_id<>old.user_id and sm.is_active and sm.is_admin) then
      raise exception 'O último administrador ativo não pode ser removido ou desativado';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger staff_last_admin_update before update of is_active,is_admin on public.staff_members
for each row execute procedure public.protect_last_admin();
create trigger staff_last_admin_delete before delete on public.staff_members
for each row execute procedure public.protect_last_admin();

create or replace function public.claim_staff_invite() returns public.staff_members language plpgsql security definer set search_path=public as $$
declare v_login text; v_invite public.staff_invites; v_member public.staff_members;
begin
  select github_login into v_login from public.profiles where id=auth.uid();
  if coalesce(v_login,'')='' then raise exception 'Sua conta GitHub não possui login verificável'; end if;
  select * into v_invite from public.staff_invites
    where lower(github_login)=lower(v_login) and is_active for update;
  if not found then raise exception 'Não existe convite pendente para esta conta GitHub'; end if;
  insert into public.staff_members(user_id,github_login,display_name,is_active,is_admin)
    values(auth.uid(),v_login,coalesce(v_invite.display_name,(select display_name from public.profiles where id=auth.uid())),true,v_invite.is_admin)
    on conflict(user_id) do update set github_login=excluded.github_login,display_name=excluded.display_name,is_active=true,is_admin=excluded.is_admin
    returning * into v_member;
  delete from public.user_roles where user_id=auth.uid();
  insert into public.user_roles(user_id,role_code) select auth.uid(),r from unnest(v_invite.roles) r where r<>'ADMIN';
  delete from public.staff_invites where github_login=v_invite.github_login;
  return v_member;
end $$;

create or replace function public.start_catalog_production(p_catalog_id uuid) returns public.chapters language plpgsql security definer set search_path=public as $$
declare v_catalog public.work_chapter_catalog; v_chapter public.chapters; v_raw_id uuid;
begin
  if not public.has_role('RAW_PROVIDER') then raise exception 'O cargo Raw Provider é necessário'; end if;
  select * into v_catalog from public.work_chapter_catalog where id=p_catalog_id for update;
  if not found then raise exception 'Capítulo não encontrado no catálogo'; end if;
  if v_catalog.status<>'TODO' then raise exception 'Este capítulo acabou de entrar em produção por outro membro'; end if;
  insert into public.chapters(work_id,number,catalog_id,created_by)
    values(v_catalog.work_id,v_catalog.number::text,v_catalog.id,auth.uid())
    on conflict(work_id,number) do update set catalog_id=coalesce(public.chapters.catalog_id,excluded.catalog_id)
    returning * into v_chapter;
  select id into v_raw_id from public.chapter_stages where chapter_id=v_chapter.id and stage='RAW' for update;
  if not found then raise exception 'Não foi possível inicializar o workflow'; end if;
  if (select status from public.chapter_stages where id=v_raw_id)<>'AVAILABLE' then raise exception 'RAW já foi assumido'; end if;
  update public.work_chapter_catalog set status='IN_PRODUCTION' where id=v_catalog.id;
  update public.chapter_stages set status='IN_PROGRESS',assigned_to=auth.uid(),assigned_at=now() where id=v_raw_id;
  insert into public.stage_assignments(chapter_stage_id,user_id,assigned_by) values(v_raw_id,auth.uid(),auth.uid());
  delete from public.notifications where chapter_stage_id=v_raw_id and kind='stage_available';
  delete from public.activity_log where chapter_id=v_chapter.id and stage='RAW' and action='stage_available';
  perform public.add_activity(v_chapter.id,'production_started','RAW',jsonb_build_object('catalog_id',v_catalog.id));
  return v_chapter;
end $$;

-- Reserve the metadata/version before uploading. Locking the stage row serializes
-- version allocation; the generated key never contains an unsafe client filename.
create or replace function public.reserve_artifact_upload(
  p_chapter_id uuid, p_stage public.stage_code, p_original_name text,
  p_mime_type text, p_byte_size bigint, p_note text default null
) returns public.artifacts language plpgsql security definer set search_path=public as $$
declare v_stage public.chapter_stages; v_artifact public.artifacts; v_version integer; v_ext text;
begin
  select * into v_stage from public.chapter_stages where chapter_id=p_chapter_id and stage=p_stage for update;
  if not found or not public.has_role(public.required_role(p_stage)) or (v_stage.assigned_to<>auth.uid() and not public.is_admin()) or v_stage.status<>'IN_PROGRESS' then
    raise exception 'Você não pode enviar arquivos para esta etapa';
  end if;
  if p_byte_size<=0 or p_byte_size>1073741824 then raise exception 'Arquivo inválido ou maior que 1 GB'; end if;
  select coalesce(max(version),0)+1 into v_version from public.artifacts where chapter_id=p_chapter_id and stage=p_stage;
  v_ext := case lower(coalesce(p_mime_type,'')) when 'application/zip' then '.zip' when 'application/pdf' then '.pdf'
    when 'image/jpeg' then '.jpg' when 'image/png' then '.png' when 'image/webp' then '.webp' else '.bin' end;
  insert into public.artifacts(chapter_id,stage,provider,provider_key,original_name,mime_type,byte_size,version,uploaded_by,note,upload_status,is_current)
    values(p_chapter_id,p_stage,'supabase',p_chapter_id::text||'/'||lower(p_stage::text)||'/v'||v_version||'/'||gen_random_uuid()::text||v_ext,
      left(p_original_name,255),p_mime_type,p_byte_size,v_version,auth.uid(),p_note,'PENDING',false) returning * into v_artifact;
  return v_artifact;
end $$;

create or replace function public.finalize_artifact_upload(p_artifact_id uuid) returns public.artifacts language plpgsql security definer set search_path=public as $$
declare v_artifact public.artifacts;
begin
  select * into v_artifact from public.artifacts where id=p_artifact_id for update;
  if not found or (v_artifact.uploaded_by<>auth.uid() and not public.is_admin()) or v_artifact.upload_status<>'PENDING' then raise exception 'Upload inválido'; end if;
  if not public.has_role(public.required_role(v_artifact.stage)) then raise exception 'Seu cargo não permite enviar para esta etapa'; end if;
  update public.artifacts set upload_status='AVAILABLE' where id=p_artifact_id returning * into v_artifact;
  update public.artifacts set is_current=false,superseded_at=coalesce(superseded_at,now())
    where chapter_id=v_artifact.chapter_id and stage=v_artifact.stage and is_current;
  update public.artifacts set is_current=true,superseded_at=null where id=(
    select id from public.artifacts where chapter_id=v_artifact.chapter_id and stage=v_artifact.stage and upload_status='AVAILABLE' order by version desc limit 1
  );
  perform public.add_activity(v_artifact.chapter_id,'uploaded',v_artifact.stage,jsonb_build_object('artifact_id',v_artifact.id,'version',v_artifact.version));
  return v_artifact;
end $$;

create or replace function public.complete_stage(p_stage_id uuid, p_note text default null) returns public.chapter_stages language plpgsql security definer set search_path=public as $$
declare v_stage public.chapter_stages; v_artifact uuid;
begin
  select * into v_stage from public.chapter_stages where id=p_stage_id for update;
  if not found or (v_stage.assigned_to<>auth.uid() and not public.is_admin()) then raise exception 'Você não é responsável por esta tarefa'; end if;
  if not public.has_role(public.required_role(v_stage.stage)) then raise exception 'Seu cargo não permite concluir esta etapa'; end if;
  if v_stage.status<>'IN_PROGRESS' or v_stage.stage in ('REVIEW','READY') then raise exception 'Esta etapa não pode ser concluída assim'; end if;
  select id into v_artifact from public.artifacts where chapter_id=v_stage.chapter_id and stage=v_stage.stage and upload_status='AVAILABLE' and is_current order by version desc limit 1;
  if v_artifact is null then raise exception 'Envie um arquivo válido antes de concluir a etapa'; end if;
  update public.chapter_stages set status='COMPLETED',completed_at=now() where id=p_stage_id returning * into v_stage;
  update public.stage_assignments set ended_at=now() where chapter_stage_id=p_stage_id and ended_at is null;
  insert into public.stage_completions(chapter_stage_id,chapter_id,stage,user_id,artifact_id,note) values(v_stage.id,v_stage.chapter_id,v_stage.stage,coalesce(v_stage.assigned_to,auth.uid()),v_artifact,p_note);
  perform public.add_activity(v_stage.chapter_id,'completed',v_stage.stage,jsonb_build_object('artifact_id',v_artifact,'note',p_note));
  perform public.refresh_chapter_workflow(v_stage.chapter_id);
  return v_stage;
end $$;

create or replace function public.review_chapter(p_stage_id uuid,p_approved boolean,p_reason text default null,p_return_stage public.stage_code default null) returns void language plpgsql security definer set search_path=public as $$
declare v_review public.chapter_stages; v_type_artifact uuid; v_target_id uuid; v_catalog_id uuid;
begin
  select * into v_review from public.chapter_stages where id=p_stage_id for update;
  if not found or v_review.stage<>'REVIEW' or (v_review.assigned_to<>auth.uid() and not public.is_admin()) or v_review.status<>'IN_PROGRESS' then raise exception 'Revisão inválida'; end if;
  if not public.has_role('REVIEWER_QC') then raise exception 'O cargo Revisor / QC é necessário'; end if;
  if not p_approved and (coalesce(trim(p_reason),'')='' or p_return_stage not in ('CLEAN_REDRAW','TRANSLATION','TYPESET')) then raise exception 'Reprovação exige motivo e etapa de retorno'; end if;
  if p_approved then
    select id into v_type_artifact from public.artifacts where chapter_id=v_review.chapter_id and stage='TYPESET' and upload_status='AVAILABLE' and is_current order by version desc limit 1;
    if v_type_artifact is null then raise exception 'Não existe arquivo final de Type válido'; end if;
    update public.chapter_stages set status='COMPLETED',completed_at=now(),rejection_reason=null where id=p_stage_id;
    update public.stage_assignments set ended_at=now() where chapter_stage_id=p_stage_id and ended_at is null;
    insert into public.stage_completions(chapter_stage_id,chapter_id,stage,user_id,artifact_id) values(v_review.id,v_review.chapter_id,'REVIEW',coalesce(v_review.assigned_to,auth.uid()),v_type_artifact);
    update public.chapter_stages set status='COMPLETED',completed_at=now() where chapter_id=v_review.chapter_id and stage='READY';
    select catalog_id into v_catalog_id from public.chapters where id=v_review.chapter_id;
    update public.work_chapter_catalog set status='COMPLETED' where id=v_catalog_id;
    insert into public.notifications(recipient_id,chapter_id,chapter_stage_id,kind,body,link_path)
      select distinct sm.user_id,v_review.chapter_id,v_review.id,'chapter_ready',public.chapter_label(v_review.chapter_id)||' foi aprovado e está pronto para publicação.','#/chapters/'||v_review.chapter_id
      from public.staff_members sm left join public.stage_completions sc on sc.user_id=sm.user_id and sc.chapter_id=v_review.chapter_id
      where sm.is_active and (sm.is_admin or sc.id is not null);
    perform public.add_activity(v_review.chapter_id,'approved','REVIEW',jsonb_build_object('artifact_id',v_type_artifact));
  else
    update public.stage_assignments set ended_at=now(),released_at=now() where chapter_stage_id=p_stage_id and ended_at is null;
    update public.chapter_stages set status='REJECTED',assigned_to=null,assigned_at=null,rejection_reason=p_reason where id=p_stage_id;
    if p_return_stage='TYPESET' then
      update public.chapter_stages set status='AVAILABLE',assigned_to=null,assigned_at=null,completed_at=null,rejection_reason=p_reason where chapter_id=v_review.chapter_id and stage='TYPESET' returning id into v_target_id;
    elsif p_return_stage='TRANSLATION' then
      update public.chapter_stages set status='AVAILABLE',assigned_to=null,assigned_at=null,completed_at=null,rejection_reason=p_reason where chapter_id=v_review.chapter_id and stage='TRANSLATION' returning id into v_target_id;
      update public.chapter_stages set status='WAITING',assigned_to=null,assigned_at=null,completed_at=null where chapter_id=v_review.chapter_id and stage='TYPESET';
    else
      update public.chapter_stages set status='AVAILABLE',assigned_to=null,assigned_at=null,completed_at=null,rejection_reason=p_reason where chapter_id=v_review.chapter_id and stage='CLEAN_REDRAW' returning id into v_target_id;
      update public.chapter_stages set status='WAITING',assigned_to=null,assigned_at=null,completed_at=null where chapter_id=v_review.chapter_id and stage='TYPESET';
    end if;
    update public.chapter_stages set status='WAITING',completed_at=null where chapter_id=v_review.chapter_id and stage='READY';
    update public.artifacts set is_current=false,superseded_at=now() where chapter_id=v_review.chapter_id and stage='TYPESET' and is_current;
    perform public.add_activity(v_review.chapter_id,'rejected','REVIEW',jsonb_build_object('reason',p_reason,'return_stage',p_return_stage));
    perform public.notify_stage_available(v_target_id,true);
  end if;
end $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('work-covers','work-covers',false,10485760,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy "staff read work covers" on storage.objects for select using(bucket_id='work-covers' and public.is_active_staff());
create policy "admins upload work covers" on storage.objects for insert with check(bucket_id='work-covers' and public.is_admin());
create policy "admins update work covers" on storage.objects for update using(bucket_id='work-covers' and public.is_admin()) with check(bucket_id='work-covers' and public.is_admin());
create policy "admins delete work covers" on storage.objects for delete using(bucket_id='work-covers' and public.is_admin());

drop policy if exists "staff upload scan artifacts" on storage.objects;
create policy "assigned staff upload scan artifacts" on storage.objects for insert with check (
  bucket_id='scan-artifacts' and exists (
    select 1 from public.chapter_stages cs
    where cs.chapter_id=(storage.foldername(name))[1]::uuid
      and lower(cs.stage::text)=(storage.foldername(name))[2]
      and cs.status='IN_PROGRESS'
      and (cs.assigned_to=auth.uid() or public.is_admin())
      and public.has_role(public.required_role(cs.stage))
  )
);

do $$ begin alter publication supabase_realtime add table public.activity_log; exception when duplicate_object then null; end $$;

revoke execute on function public.start_catalog_production(uuid) from public;
revoke execute on function public.claim_staff_invite() from public;
revoke execute on function public.reserve_artifact_upload(uuid,public.stage_code,text,text,bigint,text) from public;
revoke execute on function public.finalize_artifact_upload(uuid) from public;
grant execute on function public.start_catalog_production(uuid),public.claim_staff_invite(),public.reserve_artifact_upload(uuid,public.stage_code,text,text,bigint,text),public.finalize_artifact_upload(uuid) to authenticated;
