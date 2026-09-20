begin;

-- Memory v2 collapses the memory to one sentence. Measured across 87 real
-- captured statements, the median was 133 characters and 95% fitted inside the
-- old 280-char description, so the index-then-fetch protocol was carrying a
-- summary of something smaller than the summary. See docs/memory-v2.md part 3.
--
-- `statement` is the readable rendering and is what loads. `source` is the span
-- the user actually typed; it is stored for provenance and never injected.
alter table public.memories
  add column statement text,
  add column source text not null default '',
  add column band text not null default 'said' check (band in ('said','heard')),
  add column task_id uuid;

-- stamp_memory_revision is a before-update trigger, so a plain backfill would
-- bump every existing memory's revision and updated_at. Every client holding a
-- revision would then see a spurious conflict on its next write, and every
-- "last changed" date would read as the migration date.
alter table public.memories disable trigger stamp_memory_revision;
update public.memories set statement = description, source = description;
alter table public.memories enable trigger stamp_memory_revision;

alter table public.memories
  alter column statement set not null,
  add constraint memories_statement_check
    check (length(btrim(statement)) between 1 and 500),
  add constraint memories_source_check check (length(source) <= 4000);
alter table public.memories drop column description;

-- A name is now an optional handle rather than the primary key of the record,
-- so the uniqueness indexes have to become partial. Without the predicate the
-- second unnamed memory collides with the first on NULL.
alter table public.memories alter column name drop not null;
drop index public.memories_scope_name;
drop index public.memories_personal_name;
create unique index memories_scope_name on public.memories(owner_id, project_id, lower(btrim(name)))
  where name is not null;
create unique index memories_personal_name on public.memories(owner_id, lower(btrim(name)))
  where project_id is null and name is not null;

-- The task link asks a question, it never deletes. A memory whose task closes
-- announces a doubt before it is used; a memory whose task is deleted simply
-- loses the link and keeps the statement.
--
-- The reference is (owner_id, id) rather than the scope-qualified key tasks
-- also carries, because Postgres refuses ON DELETE SET NULL on a foreign key
-- containing a generated column, and scope_key is generated. Scope agreement is
-- therefore enforced in save_memory below, where it can raise something a
-- person can read instead of a constraint name.
alter table public.memories add constraint memories_task_fkey
  foreign key (owner_id, task_id)
  references public.tasks(owner_id, id) on delete set null;
create index memories_task on public.memories(owner_id, task_id) where task_id is not null;

-- Column privileges on this table are column level, so a new column is not
-- writable until it is named here.
grant insert(statement, source, band, task_id) on public.memories to authenticated;
grant update(statement, source, band, task_id) on public.memories to authenticated;

drop function public.save_memory(uuid, uuid, text, text, text);
drop function public.correct_memory(uuid, integer, text, text, text);
drop function public.list_memories(uuid);
drop function public.read_memory(uuid, text);

-- `band` is not a model decision. Explicitly saved is 'said'; captured from a
-- turn without confirmation is 'heard', and the agent must say a heard memory
-- out loud before relying on it.
-- PT409, not 40001: 202609110001_conflict_responses.sql moved conflicts onto a
-- code that surfaces as an ordinary HTTP 409 and preserves existing grants.
-- Recreating these functions must not quietly revert that.
create function public.save_memory(
  p_id uuid, p_project_id uuid, p_statement text, p_source text default '',
  p_band text default 'said', p_task_id uuid default null,
  p_name text default null, p_more_info text default ''
) returns public.memories language plpgsql security invoker set search_path = '' as $$
declare result public.memories;
begin
  -- A memory may only hang off a task in its own scope. Without this a router
  -- mistake could tag a personal rule to a project task, and the rule would
  -- then be flagged stale when that task closed.
  if p_task_id is not null and not exists (
    select 1 from public.tasks t
    where t.id = p_task_id and t.project_id is not distinct from p_project_id
  ) then
    raise exception 'Task is not in this memory scope' using errcode = '23514';
  end if;
  insert into public.memories(id, project_id, statement, source, band, task_id, name, more_info)
    values(p_id, p_project_id, btrim(p_statement), p_source, p_band, p_task_id,
           nullif(btrim(coalesce(p_name, '')), ''), p_more_info)
    on conflict(id) do nothing;
  select * into result from public.memories where id = p_id;
  -- A retry with the same id and the same payload is the same save. A reused id
  -- carrying anything else is a conflict, never an overwrite.
  if result.id is null
    or result.project_id is distinct from p_project_id
    or result.statement is distinct from btrim(p_statement)
    or result.band is distinct from p_band
    or result.task_id is distinct from p_task_id then
    raise exception 'Memory request conflict' using errcode = 'PT409';
  end if;
  return result;
end;
$$;

create function public.correct_memory(
  p_id uuid, p_revision integer, p_statement text,
  p_name text default null, p_more_info text default ''
) returns public.memories language plpgsql security invoker set search_path = '' as $$
declare result public.memories;
begin
  -- Correcting a memory is the user confirming it, so a heard memory becomes
  -- said. That is the whole promotion rule; there is no counter.
  update public.memories
    set statement = btrim(p_statement),
        name = nullif(btrim(coalesce(p_name, '')), ''),
        more_info = p_more_info,
        band = 'said'
    where id = p_id and revision = p_revision
    returning * into result;
  if result.id is null then
    raise exception 'Memory changed or unavailable' using errcode = 'PT409';
  end if;
  return result;
end;
$$;

create function public.confirm_memory(p_id uuid, p_revision integer)
returns public.memories language plpgsql security invoker set search_path = '' as $$
declare result public.memories;
begin
  update public.memories set band = 'said'
    where id = p_id and revision = p_revision returning * into result;
  if result.id is null then
    raise exception 'Memory changed or unavailable' using errcode = 'PT409';
  end if;
  return result;
end;
$$;

-- The whole statement travels now, so there is nothing left to fetch for the
-- common row. `has_more_info` flags the rare one that still has detail behind
-- it, instead of a protocol that assumes every row does.
create function public.list_memories(p_project_id uuid)
returns table(id uuid, project_id uuid, statement text, band text, task_id uuid,
  name text, has_more_info boolean, revision integer, updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.project_id, m.statement, m.band, m.task_id, m.name,
    length(btrim(m.more_info)) > 0, m.revision, m.updated_at
  from public.memories m
  where m.project_id is not distinct from p_project_id
  order by m.updated_at desc, m.id;
$$;

create function public.read_memory(p_project_id uuid, p_id uuid)
returns public.memories language plpgsql stable security invoker set search_path = '' as $$
declare result public.memories;
begin
  select * into result from public.memories
    where project_id is not distinct from p_project_id and id = p_id;
  if result.id is null then
    raise exception 'Memory not found or unavailable' using errcode = 'P0002';
  end if;
  return result;
end;
$$;

revoke execute on function
  public.save_memory(uuid,uuid,text,text,text,uuid,text,text),
  public.correct_memory(uuid,integer,text,text,text),
  public.confirm_memory(uuid,integer),
  public.list_memories(uuid),
  public.read_memory(uuid,uuid) from public, anon;
grant execute on function
  public.save_memory(uuid,uuid,text,text,text,uuid,text,text),
  public.correct_memory(uuid,integer,text,text,text),
  public.confirm_memory(uuid,integer),
  public.list_memories(uuid),
  public.read_memory(uuid,uuid) to authenticated;

commit;
