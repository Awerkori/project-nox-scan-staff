-- Opt-in provider. Existing Supabase artifacts and their download paths are unchanged.
create table public.artifact_storage_settings (
  id boolean primary key default true check(id),
  telegram_enabled boolean not null default false,
  bridge_url text check(bridge_url is null or bridge_url ~ '^https://[a-z0-9.-]+\.workers\.dev$')
);
insert into public.artifact_storage_settings(id) values(true);
alter table public.artifact_storage_settings enable row level security;
revoke all on public.artifact_storage_settings from public,anon,authenticated;
grant select,update on public.artifact_storage_settings to service_role;

create table public.telegram_artifact_parts (
  artifact_id uuid not null references public.artifacts(id) on delete cascade,
  part_index integer not null check(part_index>=0 and part_index<128),
  byte_size integer not null check(byte_size>0 and byte_size<=8388608),
  sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
  state text not null default 'RESERVED' check(state in ('RESERVED','STORED','UNCERTAIN')),
  lease_id uuid not null default gen_random_uuid(),
  lease_expires_at timestamptz not null default now()+interval '3 minutes',
  telegram_file_id text,
  telegram_message_id bigint,
  telegram_chat_id text,
  stored_at timestamptz,
  primary key(artifact_id,part_index),
  check(state<>'STORED' or (telegram_file_id is not null and telegram_message_id>0 and telegram_chat_id is not null and stored_at is not null))
);
alter table public.telegram_artifact_parts enable row level security;
-- File references and transfer leases never belong to the browser.
revoke all on public.telegram_artifact_parts from public,anon,authenticated;
grant select,insert,update on public.telegram_artifact_parts to service_role;

create function public.artifact_upload_configuration() returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare cfg public.artifact_storage_settings;
begin
  if not public.is_active_staff() then raise exception 'Acesso não autorizado'; end if;
  select * into cfg from public.artifact_storage_settings where id;
  return jsonb_build_object('provider',case when cfg.telegram_enabled and cfg.bridge_url is not null then 'telegram' else 'supabase' end,
    'bridge_url',cfg.bridge_url,'part_bytes',8388608);
end $$;

create or replace function public.reserve_artifact_upload(
  p_chapter_id uuid, p_stage public.stage_code, p_original_name text,
  p_mime_type text, p_byte_size bigint, p_note text default null
) returns public.artifacts language plpgsql security definer set search_path=public as $$
declare v_stage public.chapter_stages; v_artifact public.artifacts; v_version integer; v_ext text; v_telegram boolean;
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
  select telegram_enabled and bridge_url is not null into v_telegram from public.artifact_storage_settings where id;
  v_ext := case lower(coalesce(p_mime_type,'')) when 'application/zip' then '.zip' when 'application/pdf' then '.pdf'
    when 'image/jpeg' then '.jpg' when 'image/png' then '.png' when 'image/webp' then '.webp' else '.bin' end;
  insert into public.artifacts(chapter_id,stage,provider,provider_key,original_name,mime_type,byte_size,version,uploaded_by,note,upload_status,is_current)
    values(p_chapter_id,p_stage,case when v_telegram then 'telegram' else 'supabase' end,
      case when v_telegram then gen_random_uuid()::text else p_chapter_id::text||'/'||lower(p_stage::text)||'/v'||v_version||'/'||gen_random_uuid()::text||v_ext end,
      left(p_original_name,255),p_mime_type,p_byte_size,v_version,auth.uid(),p_note,'PENDING',false) returning * into v_artifact;
  return v_artifact;
end $$;

create function public.begin_telegram_artifact_part(p_artifact_id uuid,p_part_index integer,p_sha256 text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare a public.artifacts; s public.chapter_stages; part public.telegram_artifact_parts; expected integer;
begin
  select * into a from public.artifacts where id=p_artifact_id;
  perform 1 from public.chapters where id=a.chapter_id for update;
  select * into s from public.chapter_stages where chapter_id=a.chapter_id and stage=a.stage for update;
  select * into a from public.artifacts where id=p_artifact_id for update;
  if a.id is null or a.provider<>'telegram' or a.upload_status<>'PENDING' or s.status<>'IN_PROGRESS'
    or not public.has_role(public.required_role(a.stage))
    or (a.uploaded_by is distinct from auth.uid() and not public.is_admin())
    or (s.assigned_to is distinct from auth.uid() and not public.is_admin()) then raise exception 'Upload não autorizado'; end if;
  perform public.assert_stage_dependencies(a.chapter_id,a.stage);
  if p_part_index is null or p_part_index<0 or p_part_index>=ceil(a.byte_size::numeric/8388608)
    or p_sha256 is null or p_sha256 !~ '^[a-f0-9]{64}$' then raise exception 'Parte inválida'; end if;
  expected:=least(8388608,a.byte_size-p_part_index::bigint*8388608)::integer;
  select * into part from public.telegram_artifact_parts where artifact_id=a.id and part_index=p_part_index for update;
  if found then
    if part.sha256<>p_sha256 then raise exception 'O conteúdo deste arquivo mudou. Selecione o arquivo original'; end if;
    if part.state='STORED' then return jsonb_build_object('stored',true,'byte_size',expected); end if;
    -- A timeout after sending may have delivered the document: never resend blindly.
    raise exception 'Esta parte já está em envio ou precisa de confirmação. Aguarde antes de reenviar o arquivo';
  end if;
  insert into public.telegram_artifact_parts(artifact_id,part_index,byte_size,sha256)
    values(a.id,p_part_index,expected,p_sha256) returning * into part;
  return jsonb_build_object('stored',false,'byte_size',expected,'lease_id',part.lease_id);
end $$;

-- Only the trusted transfer worker can attest to Telegram acknowledgements.
create function public.confirm_telegram_artifact_part(p_artifact_id uuid,p_part_index integer,p_lease_id uuid,
  p_file_id text,p_message_id bigint,p_chat_id text,p_byte_size integer,p_sha256 text) returns void
language plpgsql security definer set search_path=public as $$
declare part public.telegram_artifact_parts;
begin
  select * into part from public.telegram_artifact_parts where artifact_id=p_artifact_id and part_index=p_part_index for update;
  if not found or part.lease_id is distinct from p_lease_id or part.sha256 is distinct from p_sha256 or part.byte_size is distinct from p_byte_size
    or coalesce(p_file_id,'')='' or coalesce(p_chat_id,'')='' or coalesce(p_message_id,0)<=0 then raise exception 'Confirmação de arquivo inválida'; end if;
  if part.state='STORED' then
    if part.telegram_file_id<>p_file_id or part.telegram_message_id<>p_message_id or part.telegram_chat_id<>p_chat_id then
      raise exception 'Esta parte já possui outro arquivo confirmado';
    end if;
    return;
  end if;
  update public.telegram_artifact_parts set state='STORED',telegram_file_id=p_file_id,telegram_message_id=p_message_id,
    telegram_chat_id=p_chat_id,stored_at=now() where artifact_id=p_artifact_id and part_index=p_part_index;
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
  if a.provider='supabase' then
    if not exists(select 1 from storage.objects where bucket_id='scan-artifacts' and name=a.provider_key
      and (metadata->>'size')::bigint=a.byte_size) then raise exception 'O arquivo ainda não terminou de enviar'; end if;
  elsif a.provider='telegram' then
    if (select count(*) from public.telegram_artifact_parts where artifact_id=a.id and state='STORED')<>ceil(a.byte_size::numeric/8388608)
      or (select coalesce(sum(byte_size),0) from public.telegram_artifact_parts where artifact_id=a.id and state='STORED')<>a.byte_size then
      raise exception 'O arquivo ainda não terminou de enviar';
    end if;
  else raise exception 'Armazenamento não suportado'; end if;
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

create function public.reset_unsent_telegram_part(p_artifact_id uuid,p_part_index integer,p_lease_id uuid) returns void
language sql security definer set search_path=public as $$
  delete from public.telegram_artifact_parts where artifact_id=p_artifact_id and part_index=p_part_index and lease_id=p_lease_id and state='RESERVED'
$$;

create function public.telegram_download_manifest(p_provider_key text) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare a public.artifacts;
begin
  if not public.is_active_staff() then raise exception 'Acesso não autorizado'; end if;
  select * into a from public.artifacts where provider='telegram' and provider_key=p_provider_key and upload_status='AVAILABLE';
  if not found then raise exception 'Arquivo indisponível'; end if;
  return jsonb_build_object('artifact_id',a.id,'name',a.original_name,'mime_type',a.mime_type,'byte_size',a.byte_size,
    'parts',(select jsonb_agg(jsonb_build_object('index',part_index,'byte_size',byte_size,'sha256',sha256) order by part_index)
      from public.telegram_artifact_parts where artifact_id=a.id and state='STORED'));
end $$;

revoke execute on function public.artifact_upload_configuration(),public.begin_telegram_artifact_part(uuid,integer,text),
  public.confirm_telegram_artifact_part(uuid,integer,uuid,text,bigint,text,integer,text),public.telegram_download_manifest(text)
  from public,anon,authenticated;
revoke execute on function public.reset_unsent_telegram_part(uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.reset_unsent_telegram_part(uuid,integer,uuid) to service_role;
grant execute on function public.artifact_upload_configuration(),public.begin_telegram_artifact_part(uuid,integer,text),
  public.telegram_download_manifest(text) to authenticated;
grant execute on function public.confirm_telegram_artifact_part(uuid,integer,uuid,text,bigint,text,integer,text) to service_role;
