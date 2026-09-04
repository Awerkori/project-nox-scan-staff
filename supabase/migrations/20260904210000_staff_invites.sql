-- Allows an administrator to pre-authorize a GitHub account before its first OAuth login.
create table public.staff_invites (
  github_login text primary key,
  display_name text,
  is_active boolean not null default true,
  is_admin boolean not null default false,
  roles public.role_code[] not null default '{}',
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.staff_invites enable row level security;
create policy "admin manage staff invites" on public.staff_invites for all using (public.is_admin()) with check (public.is_admin());

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare v_login text; v_invite public.staff_invites;
begin
  v_login := coalesce(new.raw_user_meta_data ->> 'user_name', new.raw_user_meta_data ->> 'preferred_username');
  insert into public.profiles (id, github_login, display_name, avatar_url)
  values (new.id, v_login, new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'avatar_url')
  on conflict (id) do update set github_login = excluded.github_login, display_name = excluded.display_name, avatar_url = excluded.avatar_url;
  select * into v_invite from public.staff_invites where lower(github_login)=lower(v_login) and is_active;
  if found then
    insert into public.staff_members(user_id,github_login,display_name,is_active,is_admin)
    values(new.id,v_login,coalesce(v_invite.display_name,new.raw_user_meta_data ->> 'full_name'),true,v_invite.is_admin)
    on conflict(user_id) do update set github_login=excluded.github_login,display_name=excluded.display_name,is_active=true,is_admin=excluded.is_admin;
    insert into public.user_roles(user_id,role_code)
      select new.id, unnest(v_invite.roles) on conflict do nothing;
    delete from public.staff_invites where github_login=v_invite.github_login;
  end if;
  return new;
end $$;
