---
name: satchel-projects
description: How Satchel's projects work and why they are shaped this way. Use when changing the projects table, the project upsert or delete routines, repository links, the repository hint bridge, session scope selection, or anything under src/features/projects/. Projects are the scope that memories, tasks and grants hang off, so read this before changing what a scope means. This documents the system for people building it, not for agents using it.
---

# Satchel projects, and why they are shaped this way

A project is the effort, not its storage container. It has an outcome, a brief and work to do. It can have zero, one or several code repositories, and a repository can support more than one effort. It is the scope that memories, tasks and grants hang off, so almost every other decision in Satchel bottoms out here.

## The one paragraph version

A project is a row with a stable UUID, a slug, a name, a brief and a revision. Personal scope is the absence of a project: `project_id is null`, everywhere, in every table. A project may link GitHub repositories, one repository to at most one project per owner. A conversation picks an active project for itself only, either explicitly or by a short-lived repository hint staged from the local Git origin. Picking never expands a grant. Creating never expands a grant either, which is why `upsert_project` returns `grant_required`.

## Read this first, then route

| What you are doing | Read |
| --- | --- |
| Changing the table, the upsert, delete, or slugs | `references/schema.md` |
| Changing repository links, the hint bridge, or how a conversation picks a scope | `references/scoping.md` |
| Anything at all, before you trust a green test | `references/traps.md` |

Read `security` for the grant model, `satchel-apps` for how a connection is authorized, `satchel-tasks` and `satchel-memory` for what lives inside a scope.

## The rules that outrank convenience

**Personal is `project_id is null`, everywhere.** Not a magic UUID, not a row named "Personal". Tasks give it a non-null `scope_key` of `'personal'` for composite foreign keys, but the scope itself is the null. An unknown scope must never default to personal.

**A project is not a repository.** It can have none. It can have several. A repository can serve two projects only in the sense that the link is per owner and exclusive, so a repository maps to at most one project. Nothing creates a repository when you make a project, and no repository is required to make a task.

**Repository linking is routing, never authorization.** Resolving `owner/name` to a project can only reach a link whose project is already in the connection's grant. RLS exposes nothing else. A link is a shortcut for "which project am I in", not a permission.

**Selecting a project is session-local.** `agent_session_scopes` is keyed by `(owner_id, client_id, session_key)` and carries the grant generation. It changes this conversation and nothing else, and it is invalidated the moment the generation rotates.

**Creating a project does not grant access to it.** An agent with write capability can create one, and then cannot read it. `upsert_project` returns `grant_required: true` so the agent can say so out loud instead of failing mysteriously later.

**Every project write is revision-checked and idempotent.** `expected_revision` omitted means create; supplied means update, and a mismatch is `PT409`. `project_write_requests` keys `(owner_id, request_id)` to a payload hash, so the identical retry returns the stored result and a reused ID with a different payload is refused.

**Deleting is a person's action, and it says what it took.** `delete_project` is companion-only, revision-checked, and returns the counts of memories, tasks and files removed. It also drops the project from every connection's `project_ids`.

## Where things live

```
supabase/migrations/
  202609100001_foundation.sql              projects, memories, the base policies
  202609150001_project_repositories.sql    links, link/unlink, select_agent_repository
  202609150003_agent_repository_hints.sql  the anonymous staging bridge
  202609110003_agent_connections.sql       agent_session_scopes, select_agent_project
  20260917042603_upsert_projects.sql       revision, receipt table, upsert_project
  20260920100000_slugs.sql                 slugs and upsert_project_with_slug
  20260917170000_delete_tasks_and_projects.sql   companion-only delete
server/memory-service.mjs        projects(), upsertProject, selectProject, selectRepository
server/repository-hint-handler.mjs  validates and stages a repository identity
api/repository-hint.mjs          the one anonymous endpoint
integrations/shared/bootstrap.mjs   reads the local Git origin, stages the hint
src/features/projects/           repository, list, new-project sheet, page, links
```

## When you change something

1. Anything that changes what a scope means is a migration and a decision, not a refactor. `docs/projects.md` is the product model and `docs/decisions.md` is the ledger.
2. A new scope kind starts with the domain union and an intentional migration. Unknown scopes must not fall back to personal.
3. If you touch the hint bridge, re-read `references/traps.md` first: it is the only anonymous write surface in the product.
4. `npm test` and `npm run build` pass before a push.
