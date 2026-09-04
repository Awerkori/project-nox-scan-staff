-- Catalog only: this table never invokes chapters/chapter_stages workflow triggers.
create type public.catalog_chapter_status as enum ('TODO', 'IN_PRODUCTION', 'COMPLETED');

alter table public.works add column synopsis text not null default '';

create table public.work_chapter_catalog (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.works(id) on delete cascade,
  number integer not null check (number > 0),
  status public.catalog_chapter_status not null default 'TODO',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(work_id, number)
);
create index work_chapter_catalog_work_status_idx on public.work_chapter_catalog(work_id, status, number);
create trigger catalog_touch before update on public.work_chapter_catalog for each row execute procedure public.touch_updated_at();

alter table public.work_chapter_catalog enable row level security;
create policy "staff read work catalog" on public.work_chapter_catalog for select using (public.is_active_staff());
create policy "admin manage work catalog" on public.work_chapter_catalog for all using (public.is_admin()) with check (public.is_admin());

create or replace function public.add_catalog_chapter_range(p_work_id uuid, p_start integer, p_end integer) returns table(added integer, existing integer) language plpgsql security definer set search_path=public as $$
declare v_added integer;
begin
  if not public.is_admin() then raise exception 'Somente administradores podem alterar o catálogo'; end if;
  if p_start < 1 or p_end < p_start then raise exception 'Intervalo inválido'; end if;
  with inserted as (
    insert into public.work_chapter_catalog(work_id,number)
    select p_work_id, value from generate_series(p_start,p_end) value
    on conflict(work_id,number) do nothing returning 1
  ) select count(*) into v_added from inserted;
  return query select v_added, (p_end-p_start+1)-v_added;
end $$;

create or replace function public.set_catalog_chapter_status_range(p_work_id uuid, p_start integer, p_end integer, p_status public.catalog_chapter_status) returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
  if not public.is_admin() then raise exception 'Somente administradores podem alterar o catálogo'; end if;
  update public.work_chapter_catalog set status=p_status where work_id=p_work_id and number between p_start and p_end;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
