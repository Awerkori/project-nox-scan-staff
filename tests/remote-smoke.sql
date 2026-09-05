-- Authorized production check. All test writes are rolled back.
-- Uses the confirmed existing Typesetter and administrator identities.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','02562664-d04a-4f01-99d6-56c5bf628bb0',true);
do $$ declare denied boolean := false; n integer; begin
  if not public.is_active_staff() or not public.has_role('TYPESETTER') or public.is_admin()
    or public.has_role('RAW_PROVIDER') or public.has_role('CLEAN_REDRAW') or public.has_role('TRANSLATOR') or public.has_role('REVIEWER_QC') then
    raise exception 'Typesetter permissions mismatch';
  end if;
  perform public.claim_staff_invite(); -- Existing-member re-entry is idempotent.
  begin perform public.add_catalog_chapter_range(gen_random_uuid(),1,2); exception when others then denied:=true; end;
  if not denied then raise exception 'Unauthorized catalog administration accepted'; end if;
  denied:=false;
  begin perform public.start_catalog_production(gen_random_uuid()); exception when others then denied:=true; end;
  if not denied then raise exception 'Unauthorized RAW accepted'; end if;
  denied:=false;
  begin perform public.review_chapter(gen_random_uuid(),true); exception when others then denied:=true; end;
  if not denied then raise exception 'Unauthorized QC accepted'; end if;
  update public.chapters set published_at=now(); get diagnostics n=row_count;
  if n<>0 then raise exception 'Direct chapter writes accepted'; end if;
  if has_function_privilege('authenticated','public.refresh_chapter_workflow(uuid)','execute') then raise exception 'Internal RPC exposed'; end if;
end $$;
select set_config('request.jwt.claim.sub','46dce535-621d-43de-99d4-1aef047e08d5',true);
do $$ declare denied boolean:=false; begin
  perform public.claim_staff_invite();
  if not public.is_admin() then raise exception 'Administrator access broken'; end if;
  begin update public.staff_members set is_admin=false where user_id=auth.uid(); exception when others then denied:=true; end;
  if not denied then raise exception 'Last administrator protection failed'; end if;
end $$;
rollback;
select 'PASS: existing-member re-entry, roles, denied RPCs, direct writes and last-admin guard; all writes rolled back' as result;
