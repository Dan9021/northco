-- Staff applications for Northco.
-- Run AFTER supabase_profiles.sql (it uses public.is_admin() and public.profiles).
-- Supabase: SQL Editor -> New query -> paste -> Run. Safe to run again.
--
-- Who can do what:
--   anyone .......... read OPEN job openings
--   signed-in user .. send an application for an open role, read / withdraw their own pending ones
--   admins .......... manage openings, read all applications, accept / reject, add a private note
-- Every rule lives here, in the database, because the browser can be tampered with.

-- ---------------------------------------------------------------- openings
create table if not exists public.job_openings (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 2 and 80),
  description text not null default '' check (char_length(description) <= 1000),
  is_open boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.job_openings enable row level security;

drop policy if exists "job_openings_read" on public.job_openings;
create policy "job_openings_read"
on public.job_openings
for select
to anon, authenticated
using (is_open or public.is_admin());

drop policy if exists "job_openings_admin_insert" on public.job_openings;
create policy "job_openings_admin_insert"
on public.job_openings
for insert
to authenticated
with check (public.is_admin());

drop policy if exists "job_openings_admin_update" on public.job_openings;
create policy "job_openings_admin_update"
on public.job_openings
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "job_openings_admin_delete" on public.job_openings;
create policy "job_openings_admin_delete"
on public.job_openings
for delete
to authenticated
using (public.is_admin());

-- ------------------------------------------------------------ applications
create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  opening_id uuid references public.job_openings(id) on delete set null,
  role_title text not null check (char_length(role_title) between 2 and 80),
  discord_name text not null default '' check (char_length(discord_name) <= 80),
  roblox_username text not null check (roblox_username ~ '^[A-Za-z0-9_]{3,20}$'),
  timezone text not null check (char_length(timezone) between 2 and 60),
  experience text not null check (char_length(experience) between 10 and 1500),
  motivation text not null check (char_length(motivation) between 10 and 1500),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  admin_note text check (char_length(admin_note) <= 1000),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

-- One pending application per person and role (they can apply again once it is decided or withdrawn).
create unique index if not exists applications_one_pending_per_opening
on public.applications (user_id, opening_id)
where status = 'pending';

create index if not exists applications_status_created_idx
on public.applications (status, created_at desc);

alter table public.applications enable row level security;

create or replace function public.is_banned()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select banned from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.opening_is_open(oid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from public.job_openings where id = oid and is_open);
$$;

grant execute on function public.is_banned() to authenticated;
grant execute on function public.opening_is_open(uuid) to authenticated;

drop policy if exists "applications_select_own_or_admin" on public.applications;
create policy "applications_select_own_or_admin"
on public.applications
for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "applications_insert_own" on public.applications;
create policy "applications_insert_own"
on public.applications
for insert
to authenticated
with check (
  user_id = auth.uid()
  and status = 'pending'
  and admin_note is null
  and reviewed_by is null
  and reviewed_at is null
  and not public.is_banned()
  and public.opening_is_open(opening_id)
);

-- Applicants cannot edit an application after sending it; only admins review.
drop policy if exists "applications_admin_update" on public.applications;
create policy "applications_admin_update"
on public.applications
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "applications_delete_own_pending_or_admin" on public.applications;
create policy "applications_delete_own_pending_or_admin"
on public.applications
for delete
to authenticated
using ((user_id = auth.uid() and status = 'pending') or public.is_admin());

-- On insert: take the role title and Discord name from the database instead of trusting the browser.
create or replace function public.applications_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.role_title := coalesce((select title from public.job_openings where id = new.opening_id), new.role_title);
  new.discord_name := coalesce(
    (select left(display_name, 80) from public.profiles where id = new.user_id),
    ''
  );
  return new;
end;
$$;

drop trigger if exists applications_before_insert on public.applications;
create trigger applications_before_insert
before insert on public.applications
for each row execute function public.applications_before_insert();

-- On update: the applicant's answers are frozen, and the reviewer is stamped automatically.
create or replace function public.applications_before_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_id is distinct from old.user_id
     or new.opening_id is distinct from old.opening_id
     or new.role_title is distinct from old.role_title
     or new.discord_name is distinct from old.discord_name
     or new.roblox_username is distinct from old.roblox_username
     or new.timezone is distinct from old.timezone
     or new.experience is distinct from old.experience
     or new.motivation is distinct from old.motivation
     or new.created_at is distinct from old.created_at then
    raise exception 'Applications cannot be edited after they are sent';
  end if;

  if new.status is distinct from old.status then
    new.reviewed_by := auth.uid();
    new.reviewed_at := case when new.status = 'pending' then null else now() end;
    if new.status = 'pending' then
      new.reviewed_by := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists applications_before_update on public.applications;
create trigger applications_before_update
before update on public.applications
for each row execute function public.applications_before_update();

-- Optional: a first opening so the Employment page is not empty. Delete or edit it in the admin panel.
insert into public.job_openings (title, description)
select 'Store Staff', 'Help players, keep the store tidy and welcome new visitors.'
where not exists (select 1 from public.job_openings);
