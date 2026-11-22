-- Google Forms-style application sections for Northco.
-- Run AFTER supabase_profiles.sql, supabase_applications.sql, and supabase_questions.sql.
-- Safe to run again after the first migration.

begin;

create table if not exists public.application_sections (
  id uuid primary key default gen_random_uuid(),
  opening_id uuid not null references public.job_openings(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 500),
  position integer not null default 1 check (position > 0),
  created_at timestamptz not null default now()
);

alter table public.application_questions
  add column if not exists section_id uuid;

insert into public.application_sections (opening_id, title, description, position)
select o.id, 'General', '', 1
from public.job_openings o
where not exists (
  select 1 from public.application_sections s where s.opening_id = o.id
);

update public.application_questions q
set section_id = (
  select s.id
  from public.application_sections s
  where s.opening_id = q.opening_id
  order by s.position, s.created_at
  limit 1
)
where q.section_id is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.application_sections'::regclass
      and conname = 'application_sections_id_opening_unique'
  ) then
    alter table public.application_sections
      add constraint application_sections_id_opening_unique unique (id, opening_id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.application_questions'::regclass
      and conname = 'application_questions_section_opening_fk'
  ) then
    alter table public.application_questions
      add constraint application_questions_section_opening_fk
      foreign key (section_id, opening_id)
      references public.application_sections (id, opening_id)
      deferrable initially deferred;
  end if;
end $$;

alter table public.application_questions
  alter column section_id set not null;

alter table public.application_sections enable row level security;

drop policy if exists application_sections_read on public.application_sections;
create policy application_sections_read
on public.application_sections for select to anon, authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.job_openings o
    where o.id = application_sections.opening_id and o.is_open
  )
);

drop policy if exists application_sections_admin_insert on public.application_sections;
create policy application_sections_admin_insert
on public.application_sections for insert to authenticated
with check (public.is_admin());

drop policy if exists application_sections_admin_update on public.application_sections;
create policy application_sections_admin_update
on public.application_sections for update to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists application_sections_admin_delete on public.application_sections;
create policy application_sections_admin_delete
on public.application_sections for delete to authenticated
using (public.is_admin());

grant select on public.application_sections to anon, authenticated;
grant insert, update, delete on public.application_sections to authenticated;
grant select (section_id) on public.application_questions to anon, authenticated;
grant insert (section_id) on public.application_questions to authenticated;
grant update (section_id) on public.application_questions to authenticated;

create or replace function public.add_default_questions(oid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_section_id uuid;
begin
  select s.id into v_section_id
  from public.application_sections s
  where s.opening_id = oid
  order by s.position, s.created_at
  limit 1;

  if v_section_id is null then
    insert into public.application_sections (opening_id, title, description, position)
    values (oid, 'General', '', 1)
    returning id into v_section_id;
  end if;

  if exists (
    select 1 from public.application_questions q where q.opening_id = oid
  ) then
    return;
  end if;

  insert into public.application_questions
    (opening_id, section_id, position, label, help, kind, required, max_length)
  values
    (oid, v_section_id, 1, 'Roblox username', '3 to 20 letters, numbers or underscores.', 'short', true, 20),
    (oid, v_section_id, 2, 'Time zone and usual availability', 'e.g. CET, evenings and weekends', 'short', true, 60),
    (oid, v_section_id, 3, 'Experience', 'Previous staff or community roles, anything relevant.', 'long', true, 1500),
    (oid, v_section_id, 4, 'Why do you want to join?', '', 'long', true, 1500);
end;
$$;

revoke all on function public.add_default_questions(uuid) from public, anon, authenticated;

select public.add_default_questions(o.id)
from public.job_openings o
where not exists (
  select 1 from public.application_questions q where q.opening_id = o.id
);

commit;
