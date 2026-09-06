-- Remote database-only probe. Never commits fixtures or broadcasts notifications.
-- Storage metadata is transactional; this does not test physical blob transport.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','46dce535-621d-43de-99d4-1aef047e08d5',true);
do $$
declare w uuid; catalog uuid; chapter public.chapters; s public.chapter_stages;
  artifact public.artifacts; code public.stage_code; before_count bigint;
begin
  if not public.is_admin() then raise exception 'Expected confirmed admin'; end if;
  if (select enabled from public.production_email_settings where id) then raise exception 'Email must be disabled'; end if;
  select count(*) into before_count from public.production_email_outbox;
  insert into public.works(title) values('NOX transactional notification check') returning id into w;
  perform public.add_catalog_chapter_range(w,1,1);
  select id into catalog from public.work_chapter_catalog where work_id=w and number=1;
  chapter:=public.start_catalog_production(catalog);
  perform set_config('nox.test.chapter',chapter.id::text,true);
  foreach code in array array['RAW','CLEAN_REDRAW','TRANSLATION','TYPESET']::public.stage_code[] loop
    select * into s from public.chapter_stages where chapter_id=chapter.id and stage=code;
    if s.status='AVAILABLE' then perform public.claim_stage(s.id); end if;
    artifact:=public.reserve_artifact_upload(chapter.id,code,'probe.txt','text/plain',4,null);
    insert into storage.objects(bucket_id,name,metadata) values('scan-artifacts',artifact.provider_key,'{"size":4}'::jsonb);
    perform public.finalize_artifact_upload(artifact.id);
    perform public.complete_stage(s.id);
  end loop;
  if (select count(*) from public.production_email_outbox)<>before_count then raise exception 'Disabled email generated jobs'; end if;
  if not exists(select 1 from public.chapter_stages where chapter_id=chapter.id and stage='REVIEW' and status='AVAILABLE') then
    raise exception 'Workflow failed without email';
  end if;
end $$;
select set_config('request.jwt.claim.sub','02562664-d04a-4f01-99d6-56c5bf628bb0',true);
do $$ declare n uuid; begin
  select id into n from public.notifications where chapter_id=current_setting('nox.test.chapter')::uuid
    and body like '%Type disponível.%' and recipient_id=auth.uid();
  if n is null then raise exception 'Active Typesetter did not receive internal notification'; end if;
  update public.notifications set read_at=now() where id=n;
  if not exists(select 1 from public.notifications where id=n and read_at is not null) then raise exception 'Could not mark notification read'; end if;
end $$;
rollback;
select 'PASS: remote RAW/Clean/Translation/Type transitions, internal Typesetter notification and mark-read without email; all fixtures rolled back' as result;
