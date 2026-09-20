# Project traps

**"Every project" used to mean "the projects that existed the moment you clicked."** The consent page built the grant with `projects.map(p => p.id)`, freezing a list of UUIDs. Make a project the next day and the app you had just given everything to could not see it, with no error that explained why. `all_projects` is now a state of the grant instead of a list. Anything that re-derives a list from "all" reintroduces the bug.

**Nothing was backfilled when that changed.** A connection granted "all" before the migration keeps its frozen list until the person authorizes again and sees what they are agreeing to. Widening an existing grant inside a migration would be the same bug pointing the other way.

**A project you create is not a project you can read.** `upsert_project` returns `grant_required`. If the caller ignores it, the next call fails with a policy-shaped nothing and nobody can tell why.

**Repository linking is routing, not authorization.** It is tempting to treat a matched origin as proof of access. It is not. Resolution goes through RLS and only reaches links whose project is already granted. Never widen `select_agent_repository` to "find the project for this repo".

**`/api/repository-hint` is the only anonymous write in the product.** Every change to it is a security change. It must keep: the 1024-byte cap checked twice, the strict field allowlist, the `github`-only provider, the session-key pattern, the 5-minute expiry, an empty response body, and no owner or project field anywhere. Authorization stays entirely in the authenticated consumer.

**A stale hint must not survive.** `activate_agent_repository_hint` consumes by deleting inside the same statement it reads. A "read then delete" rewrite creates a window where two sessions resolve the same hint.

**A rotated grant generation must orphan the session selection.** `agent_active_project` compares the stored `grant_id` to the JWT claim. If you relax that comparison for convenience, a revoked-and-reconnected app silently resumes the old conversation's scope.

**Unknown scope must never fall back to personal.** Personal is the null, and the null is also what an uninitialized variable looks like. Any new code path that resolves a scope has to fail loudly rather than default.

**`select t.*` and `create or replace function` both freeze things.** See `satchel-tasks/references/traps.md`; the same two failures apply to any project-side view or helper.

**Deleting a project takes memories, tasks and files with it.** The counts come back in the result for a reason. Show them. `ProjectDelete.tsx` asks first, and no agent path exists at all.

**Renaming must not orphan anything.** Everything references the stable UUID, and the slug is a handle. If you ever make something reference the name, renaming becomes a data-loss bug.

**Two accessible projects can share a name.** Names are not unique; slugs are unique per owner. Disambiguate on the slug or the id, never the name.
