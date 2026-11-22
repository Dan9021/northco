-- Run this entire file in Supabase: SQL Editor -> New query -> Run.
-- Safe to run again: it only creates or replaces things.
--
-- SECURITY NOTE: the browser talks to this database directly with the public key, so the policies
-- and the trigger below are the ONLY thing stopping a signed-in user from making themselves admin
-- or unbanning themselves. If you ran an earlier version of this file, run this one now and then
-- check who is admin:   select id, display_name from public.profiles where is_admin;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  show_email boolean not null default false,
  show_discord_id boolean not null default false,
  is_admin boolean not null default false,
  banned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_admin = true
  );
$$;

grant execute on function public.is_admin() to authenticated;

drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin"
on public.profiles
for select
to authenticated
using (auth.uid() = id or public.is_admin());

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
on public.profiles
for insert
to authenticated
with check (auth.uid() = id and is_admin = false and banned = false);

drop policy if exists "profiles_update_own_or_admin" on public.profiles;
create policy "profiles_update_own_or_admin"
on public.profiles
for update
to authenticated
using ((auth.uid() = id and banned = false) or public.is_admin())
with check (auth.uid() = id or public.is_admin());

-- Only admins may change is_admin or banned. Without this, the update policy above would let any
-- user run  update profiles set is_admin = true where id = <their id>  from the browser console.
-- Calls with no signed-in user (the SQL editor, the service role) are allowed, which is how you
-- make the first admin.
create or replace function public.guard_profile_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.is_admin is distinct from old.is_admin
       or new.banned is distinct from old.banned then
      raise exception 'Only admins can change is_admin or banned';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_privileged_columns on public.profiles;
create trigger profiles_guard_privileged_columns
before update on public.profiles
for each row execute function public.guard_profile_privileged_columns();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id,
    display_name,
    avatar_url,
    show_email,
    show_discord_id
  )
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'northco_display_name',
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      new.raw_user_meta_data->>'user_name',
      'Discord user'
    ),
    coalesce(
      new.raw_user_meta_data->>'avatar_url',
      new.raw_user_meta_data->>'picture'
    ),
    coalesce((new.raw_user_meta_data->>'northco_show_email')::boolean, false),
    coalesce((new.raw_user_meta_data->>'northco_show_discord_id')::boolean, false)
  )
  on conflict (id) do update
  set
    display_name = coalesce(profiles.display_name, excluded.display_name),
    avatar_url = coalesce(excluded.avatar_url, profiles.avatar_url),
    show_email = coalesce(excluded.show_email, profiles.show_email),
    show_discord_id = coalesce(excluded.show_discord_id, profiles.show_discord_id),
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

insert into public.profiles (id, display_name, avatar_url)
select
  id,
  coalesce(
    raw_user_meta_data->>'northco_display_name',
    raw_user_meta_data->>'full_name',
    raw_user_meta_data->>'name',
    raw_user_meta_data->>'user_name',
    'Discord user'
  ),
  coalesce(
    raw_user_meta_data->>'avatar_url',
    raw_user_meta_data->>'picture'
  )
from auth.users
on conflict (id) do nothing;

-- After running the script, sign in once in Northco, then make this account admin:
-- update public.profiles
-- set is_admin = true
-- where id = 'YOUR_AUTH_USER_UUID';

create table if not exists public.site_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.site_settings enable row level security;

insert into public.site_settings (key, value)
values ('navbar_notice', 'This site is currently available only for beta-testers.')
on conflict (key) do nothing;

drop policy if exists "site_settings_public_read" on public.site_settings;
create policy "site_settings_public_read"
on public.site_settings
for select
to anon, authenticated
using (true);

drop policy if exists "site_settings_admin_insert" on public.site_settings;
create policy "site_settings_admin_insert"
on public.site_settings
for insert
to authenticated
with check (public.is_admin());

drop policy if exists "site_settings_admin_update" on public.site_settings;
create policy "site_settings_admin_update"
on public.site_settings
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());
