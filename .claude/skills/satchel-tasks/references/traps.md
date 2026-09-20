# Task traps

Things that have already gone wrong, or that are shaped so they will.

**`select t.*` in a view is frozen at creation time.** `task_planning` could not see `tasks.slug` after the slug migration added it, because the view had expanded its column list when it was created. The only fix is to drop and recreate the view. Any migration that adds a column to `tasks` has to recreate `task_planning` too, with the definition otherwise unchanged.

**`create or replace function` silently reverts earlier migrations.** Recreating `private.agent_can_access_tasks` from an older version once dropped the personal-task scope a later migration had added. This codebase has had that failure. Before replacing a function, read every later migration that touched it and carry forward every branch.

**Null never equals null in a composite foreign key.** This is why `scope_key` exists. A child table that keys on `project_id` directly stops enforcing anything the moment the row is personal. Copy the `(owner_id, scope_key, task_id)` shape.

**A comment must not take a revision.** If you add a revision check to `add_task_comment` for symmetry, you reintroduce the exact conflict the kind exists to avoid: someone typing a comment invalidates somebody else's open editor.

**A blanket grant has no rows.** `task_all_projects` is a flag and `agent_task_grants` is empty for that connection. Code that decides access by querying the grant table alone denies the connection that was given everything. `task-service.mjs` checks the flag first; so does the database helper. Both.

**`project_ids` and `all_projects` are never both meaningful.** `authorize_agent_v3` stores an empty list alongside a blanket flag on purpose, so a stale snapshot can never sit next to the flag looking authoritative. Do not "helpfully" populate the list.

**Slug uniqueness is per table but the namespace is shared.** `projects_owner_slug` and `tasks_owner_slug` are two separate unique indexes, so nothing at the index level stops a task and a project sharing a slug. The `default_slug` trigger checks both tables, and the MCP description tells the model the namespace is shared, but `set_slug` does not cross-check. If you rely on a slug being unambiguous across both kinds, verify it rather than assuming the database did.

**`P0002` is deliberately ambiguous.** "Missing" and "you may not see it" return the same thing. Do not add a friendlier error that distinguishes them; that turns the error into an existence oracle.

**A retry is not a new write.** Reusing a `request_id` with an identical payload must return the stored result. Reusing it with a different payload must be `PT409`. Tests that generate a fresh UUID per call never exercise either path.

**One event per mutation, in the same transaction.** Not one per RPC and not a trigger that fires twice. Assert the count, not just the presence.

**Deleting is companion-only, and the check is a function call.** `private.companion_only()` reads `auth.jwt()->>'client_id'`. If you add a new destructive routine and forget the `perform`, an agent token gets it. There is no second net.

**`last_activity_at` is what lists order by.** A mutation that forgets to touch it makes the task quietly sink in every list while looking fine in a read.

**An agent-created project is not in the agent's grant.** `upsert_project` returns `grant_required: true` for exactly this. A task created against a project the connection cannot read afterwards is a confusing dead end; report the flag to the user rather than swallowing it.
