-- Authorized remote smoke check. Only newly created fixtures are changed;
-- every write (including notifications and audit) is rolled back.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','02562664-d04a-4f01-99d6-56c5bf628bb0',true);
do $$ declare f text; denied boolean; begin
  if not public.is_active_staff() or public.is_admin() then raise exception 'Expected active ordinary staff identity'; end if;
  foreach f in array array['admin_cancel_production','admin_unpublish_chapter'] loop
    denied:=false;
    begin execute format('select public.%I($1)',f) using gen_random_uuid(); exception when others then
      if sqlerrm not like 'Somente administradores%' then raise; end if;
      denied:=true;
    end;
    if not denied then raise exception 'Unauthorized administrative operation accepted'; end if;
  end loop;
  denied:=false;
  begin perform public.admin_assign_stage(gen_random_uuid(),auth.uid()); exception when others then
    if sqlerrm not like 'Somente administradores%' then raise; end if; denied:=true;
  end;
  if not denied then raise exception 'Unauthorized assignment accepted'; end if;
end $$;
select set_config('request.jwt.claim.sub','46dce535-621d-43de-99d4-1aef047e08d5',true);
do $$ declare w uuid; catalog uuid; c public.chapters; s public.chapter_stages; failed boolean:=false; begin
  if not public.is_admin() then raise exception 'Expected administrator identity'; end if;
  insert into public.works(title,synopsis) values('VALIDAÇÃO TRANSACIONAL — ADMIN','Fixture rolled back after validation') returning id into w;
  perform public.add_catalog_chapter_range(w,1,1);
  select id into catalog from public.work_chapter_catalog where work_id=w and number=1;
  c:=public.start_catalog_production(catalog);
  select * into s from public.chapter_stages where chapter_id=c.id and stage='RAW';
  perform public.admin_assign_stage(s.id,null);
  if not exists(select 1 from public.notifications where chapter_stage_id=s.id and read_at is null) then raise exception 'Released task notice missing'; end if;
  perform public.claim_stage(s.id);
  if exists(select 1 from public.notifications where chapter_stage_id=s.id and read_at is null) then raise exception 'Claimed task notice remains visible'; end if;
  perform public.admin_reopen_stage(s.id,'Teste com rollback');
  perform public.admin_cancel_production(c.id);
  if not exists(select 1 from public.work_chapter_catalog where id=catalog and status='TODO') then raise exception 'Cancellation did not restore catalog'; end if;
  if exists(select 1 from public.notifications where chapter_id=c.id) then raise exception 'Cancelled notifications remain'; end if;
  if (public.start_catalog_production(catalog)).id <> c.id then raise exception 'Restart duplicated chapter'; end if;
  begin perform public.complete_stage(s.id); exception when others then failed:=true; end;
  if not failed then raise exception 'Completed without file'; end if;
  perform public.admin_delete_chapter(c.id,'VALIDAÇÃO TRANSACIONAL — ADMIN #1');
  if exists(select 1 from public.chapters where id=c.id) or exists(select 1 from public.work_chapter_catalog where id=catalog) then raise exception 'Deletion did not remove fixture'; end if;
  if not exists(select 1 from public.chapter_admin_audit where chapter_id=c.id and action='deleted') then raise exception 'Administrative audit missing'; end if;
end $$;
rollback;
select 'PASS: remote admin RPCs, ordinary-staff denial, pending notices, cancellation, restart, deletion and audit; all writes rolled back' as result;
