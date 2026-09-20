begin;

-- Automatic capture. One small model call at the end of a turn decides whether
-- anything the user said is worth keeping. See docs/memory-v2.md part 4.
--
-- The window it reads is assembled here rather than on the user's machine. The
-- per-prompt hook already sends the prompt as a tool argument, so the server
-- can keep the last few messages itself and nothing new has to be read from
-- disk. That also means no transcript is parsed on either host, which both
-- Codex and Claude document as unreliable for different reasons.

alter table public.memory_settings
  add column capture boolean not null default true,
  add column capture_window integer not null default 5
    check (capture_window between 1 and 20);

-- A short rolling window of what the user typed, kept only long enough for the
-- turn that follows it. This is conversation text, so it is the most sensitive
-- thing Satchel holds: it is owner-scoped, never readable by another
-- connection, and expired rather than archived.
create table public.session_messages (
  id bigint generated always as identity primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  session_key text not null check (length(session_key) between 1 and 200),
  role text not null check (role in ('user', 'assistant')),
  content text not null check (length(content) <= 8000),
  created_at timestamptz not null default now()
);
create index session_messages_session on public.session_messages(owner_id, session_key, id desc);
create index session_messages_expiry on public.session_messages(created_at);
alter table public.session_messages enable row level security;
revoke all on public.session_messages from public, anon, authenticated;

-- Reached only through these routines, so a window can never be read by a
-- connection other than the one that wrote it, and rows cannot accumulate.
create function public.record_session_message(
  p_session_key text, p_role text, p_content text, p_keep integer default 12
) returns void language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid();
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if coalesce(btrim(p_content), '') = '' then return; end if;
  insert into public.session_messages(owner_id, session_key, role, content)
    values (caller, p_session_key, p_role, left(p_content, 8000));
  -- Trim as we go: the window is short by design and an unbounded log of
  -- conversation is exactly what this design exists not to keep.
  delete from public.session_messages m
    where m.owner_id = caller and m.session_key = p_session_key
      and m.id not in (
        select id from public.session_messages
        where owner_id = caller and session_key = p_session_key
        order by id desc limit greatest(p_keep, 1));
  delete from public.session_messages where created_at < now() - interval '24 hours';
end;
$$;

create function public.session_window(p_session_key text, p_limit integer default 12)
returns table(role text, content text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.role, m.content, m.created_at
  from public.session_messages m
  where m.owner_id = auth.uid() and m.session_key = p_session_key
  order by m.id desc
  limit greatest(p_limit, 1);
$$;

create function public.clear_session_window(p_session_key text) returns void
language sql security definer set search_path = '' as $$
  delete from public.session_messages
  where owner_id = auth.uid() and session_key = p_session_key;
$$;

-- What the router saw and what it said. A capture nobody can explain is worse
-- than no capture, and this is also the record that decides whether the prompt
-- is working.
create table public.router_runs (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  session_key text not null check (length(session_key) between 1 and 200),
  model text not null,
  prompt text not null check (length(prompt) <= 40000),
  response text check (length(response) <= 40000),
  kept integer not null default 0,
  dropped integer not null default 0,
  error text,
  created_at timestamptz not null default now()
);
create index router_runs_owner_created on public.router_runs(owner_id, created_at desc);
alter table public.router_runs enable row level security;
revoke all on public.router_runs from public, anon, authenticated;
grant select on public.router_runs to authenticated;
grant insert(id, session_key, model, prompt, response, kept, dropped, error)
  on public.router_runs to authenticated;
create policy owner_reads_router_runs on public.router_runs for select to authenticated
  using (owner_id = (select auth.uid()));
create policy actor_writes_router_runs on public.router_runs for insert to authenticated
  with check (owner_id = (select auth.uid()));

-- Captured memories arrive as 'heard': the user has not confirmed them, so the
-- agent announces one before relying on it. Slug resolution happens here so the
-- model never has to produce a UUID, and an unknown slug falls back to personal
-- scope, which is the harmless failure: a personal memory loads everywhere and
-- is visible noise the user can delete, while the reverse traps a rule in one
-- project where its absence is never noticed.
create function public.capture_memory(
  p_id uuid, p_statement text, p_source text,
  p_project_slug text default null, p_task_slug text default null
) returns public.memories language plpgsql security invoker set search_path = '' as $$
declare
  caller uuid := auth.uid();
  target_project uuid;
  target_task uuid;
  result public.memories;
begin
  if p_project_slug is not null then
    select id into target_project from public.projects
      where owner_id = caller and slug = p_project_slug;
  end if;
  if p_task_slug is not null then
    select id, project_id into target_task, target_project from public.tasks
      where owner_id = caller and slug = p_task_slug;
  end if;
  select * into result from public.save_memory(
    p_id, target_project, p_statement, p_source, 'heard', target_task, null, '');
  return result;
end;
$$;

revoke execute on function
  public.record_session_message(text,text,text,integer),
  public.session_window(text,integer),
  public.clear_session_window(text),
  public.capture_memory(uuid,text,text,text,text) from public, anon;
grant execute on function
  public.record_session_message(text,text,text,integer),
  public.session_window(text,integer),
  public.clear_session_window(text),
  public.capture_memory(uuid,text,text,text,text) to authenticated;

commit;
