-- Keep approved chapters separate from chapters already published by the scan.

alter table public.chapters
  add column published_at timestamptz,
  add column published_by uuid references public.profiles(id);

create index chapters_published_at_idx on public.chapters(published_at desc)
  where published_at is not null;

create or replace function public.mark_chapter_published(p_chapter_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare
  v_chapter public.chapters;
begin
  if not public.is_admin() then
    raise exception 'Somente administradores podem confirmar uma publicação';
  end if;

  select * into v_chapter
  from public.chapters
  where id=p_chapter_id
  for update;

  if not found then raise exception 'Capítulo não encontrado'; end if;
  if v_chapter.published_at is not null then return; end if;
  if not exists(
    select 1 from public.chapter_stages
    where chapter_id=p_chapter_id and stage='READY' and status='COMPLETED'
  ) then
    raise exception 'O capítulo ainda não foi aprovado pelo QC';
  end if;

  update public.chapters
  set published_at=now(),published_by=auth.uid()
  where id=p_chapter_id;
  perform public.add_activity(p_chapter_id,'published','READY');
end $$;

revoke execute on function public.mark_chapter_published(uuid) from public,anon;
grant execute on function public.mark_chapter_published(uuid) to authenticated;
