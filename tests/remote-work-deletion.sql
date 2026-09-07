-- Isolated fixtures, no external files, all writes rolled back.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','02562664-d04a-4f01-99d6-56c5bf628bb0',true);
do $$ begin
  begin perform public.admin_delete_work(gen_random_uuid(),'test');
    raise exception 'Unauthorized deletion accepted';
  exception when raise_exception then
    if sqlerrm not like 'Somente administradores%' then raise; end if;
  end;
end $$;
select set_config('request.jwt.claim.sub','46dce535-621d-43de-99d4-1aef047e08d5',true);
do $$ declare w uuid; cat uuid; c public.chapters; begin
  insert into public.works(title) values('VALIDAÇÃO TRANSACIONAL — EXCLUIR OBRA') returning id into w;
  perform public.add_catalog_chapter_range(w,1,3);
  select id into cat from public.work_chapter_catalog where work_id=w and number=1;
  c:=public.start_catalog_production(cat);
  perform public.reserve_artifact_upload(c.id,'RAW','teste.txt','text/plain',10);
  begin delete from public.works where id=w; raise exception 'Direct delete accepted'; exception when insufficient_privilege then null; end;
  perform public.admin_delete_work(w,'VALIDAÇÃO TRANSACIONAL — EXCLUIR OBRA');
  if exists(select 1 from public.chapters where work_id=w) or exists(select 1 from public.work_chapter_catalog where work_id=w) or exists(select 1 from public.artifacts where chapter_id=c.id) then raise exception 'Related data remained'; end if;
end $$;
rollback;
select 'PASS: remote work deletion, cascade, admin-only permission and direct-delete denial; all test writes rolled back, no external files' as result;
