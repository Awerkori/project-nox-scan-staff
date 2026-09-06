-- Email is optional. In-app notifications never depend on this setting.
-- The enum value must commit before the following migration uses it.
alter type public.email_delivery_status add value if not exists 'CANCELLED';
create table public.production_email_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false
);
insert into public.production_email_settings(id,enabled) values(true,false);
alter table public.production_email_settings enable row level security;
create policy "admins inspect email setting" on public.production_email_settings
  for select using(public.is_admin());
revoke all on public.production_email_settings from public,anon,authenticated;
grant select on public.production_email_settings to authenticated;
grant select,update on public.production_email_settings to service_role;
