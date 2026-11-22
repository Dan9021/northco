-- Editable application questions and role requirements for Northco.
-- Run AFTER supabase_profiles.sql and supabase_applications.sql.
-- Supabase: SQL Editor -> New query -> paste -> Run. Safe to run again.
--
-- What this adds:
--   job_openings.requirements ........ free text, one requirement per line, shown on the role's page
--   application_questions ............ the questions of each role's application form (admins edit them)
--   applications.answers ............. the answers, stored with the question text they answered
-- Rules live here, in the database: the server checks that required questions are answered and that
-- answers are not too long, and it rebuilds the stored answers from the real questions, so a tampered
-- browser cannot invent questions or skip required ones.

-- ------------------------------------------------------------ requirements
alter table public.job_openings
  add column if not exists requirements text not null default ''
  check (char_length(requirements) <= 2000);

-- --------------------------------------------------------------- questions
create table if not exists public.application_questions (
  id uuid primary key default gen_random_uuid(),
  opening_id uuid not null references public.job_openings(id) on delete cascade,
  position integer not null default 0,
  label text not null check (char_length(label) between 2 and 200),
  help text not null default '' check (char_length(help) <= 300),
  kind text not null default 'long' check (kind in ('short', 'long')),
  required boolean not null default true,
  max_length integer not null default 1500 check (max_length between 1 and 3000),
  created_at timestamptz not null default now()
);

create index if not exists application_questions_opening_idx
on public.application_questions (opening_id, position);

alter table public.application_questions enable row level security;

drop policy if exists "application_questions_read" on public.application_questions;
create policy "application_questions_read"
on public.application_questions
for select
to anon, authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.job_openings o
    where o.id = application_questions.opening_id and o.is_open
  )
);

drop policy if exists "application_questions_admin_insert" on public.application_questions;
create policy "application_questions_admin_insert"
on public.application_questions
for insert
to authenticated
with check (public.is_admin());

drop policy if exists "application_questions_admin_update" on public.application_questions;
create policy "application_questions_admin_update"
on public.application_questions
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "application_questions_admin_delete" on public.application_questions;
create policy "application_questions_admin_delete"
on public.application_questions
for delete
to authenticated
using (public.is_admin());

-- Every new role starts with these four questions (admins can change them afterwards).
create or replace function public.add_default_questions(oid uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.application_questions (opening_id, position, label, help, kind, required, max_length)
  values
    (oid, 1, 'Roblox username', '3 to 20 letters, numbers or underscores.', 'short', true, 20),
    (oid, 2, 'Time zone and usual availability', 'e.g. CET, evenings and weekends', 'short', true, 60),
    (oid, 3, 'Experience', 'Previous staff or community roles, anything relevant.', 'long', true, 1500),
    (oid, 4, 'Why do you want to join?', '', 'long', true, 1500);
$$;

revoke all on function public.add_default_questions(uuid) from public, anon, authenticated;

create or replace function public.job_openings_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.add_default_questions(new.id);
  return new;
end;
$$;

drop trigger if exists job_openings_after_insert on public.job_openings;
create trigger job_openings_after_insert
after insert on public.job_openings
for each row execute function public.job_openings_after_insert();

-- Roles that already exist get the same four questions, so nothing breaks.
select public.add_default_questions(o.id)
from public.job_openings o
where not exists (select 1 from public.application_questions q where q.opening_id = o.id);

-- ----------------------------------------------------------------- answers
alter table public.applications
  add column if not exists answers jsonb not null default '[]'::jsonb;

-- The old fixed columns stay for applications sent before this change; new ones leave them empty.
alter table public.applications alter column roblox_username drop not null;
alter table public.applications alter column timezone drop not null;
alter table public.applications alter column experience drop not null;
alter table public.applications alter column motivation drop not null;

alter table public.applications drop constraint if exists applications_roblox_username_check;
alter table public.applications add constraint applications_roblox_username_check
  check (roblox_username is null or roblox_username ~ '^[A-Za-z0-9_]{3,20}$');

alter table public.applications drop constraint if exists applications_timezone_check;
alter table public.applications add constraint applications_timezone_check
  check (timezone is null or char_length(timezone) between 2 and 60);

alter table public.applications drop constraint if exists applications_experience_check;
alter table public.applications add constraint applications_experience_check
  check (experience is null or char_length(experience) between 10 and 1500);

alter table public.applications drop constraint if exists applications_motivation_check;
alter table public.applications add constraint applications_motivation_check
  check (motivation is null or char_length(motivation) between 10 and 1500);

alter table public.applications drop constraint if exists applications_answers_size_check;
alter table public.applications add constraint applications_answers_size_check
  check (pg_column_size(answers) < 60000);

-- On insert: the browser sends  { "<question id>": "answer text" }.  We check it against the role's real
-- questions and store a list that carries the question text, so later edits to a question never change
-- what an old application was answering.
create or replace function public.applications_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  q record;
  raw jsonb := new.answers;
  given text;
  result jsonb := '[]'::jsonb;
begin
  new.role_title := coalesce((select title from public.job_openings where id = new.opening_id), new.role_title);
  new.discord_name := coalesce(
    (select left(display_name, 80) from public.profiles where id = new.user_id),
    ''
  );

  if jsonb_typeof(raw) is distinct from 'object' then
    raw := '{}'::jsonb;
  end if;

  for q in
    select * from public.application_questions
    where opening_id = new.opening_id
    order by position, created_at
  loop
    given := btrim(coalesce(raw ->> (q.id)::text, ''));
    if given = '' then
      if q.required then
        raise exception 'Please answer: %', q.label using errcode = '23514';
      end if;
      continue;
    end if;
    if char_length(given) > q.max_length then
      raise exception 'Answer too long (max % characters): %', q.max_length, q.label using errcode = '23514';
    end if;
    result := result || jsonb_build_array(
      jsonb_build_object('question_id', q.id, 'label', q.label, 'answer', given)
    );
  end loop;

  if jsonb_array_length(result) = 0 then
    raise exception 'This role has no questions to answer yet' using errcode = '23514';
  end if;

  new.answers := result;
  return new;
end;
$$;

-- On update: the applicant's answers stay frozen, and the reviewer is stamped automatically.
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
     or new.answers is distinct from old.answers
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
