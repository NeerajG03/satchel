# App traps

Things that have already gone wrong here, or that are shaped so they will.

**`create or replace function` silently reverts an earlier migration.** Both access helpers have been replaced from an older copy and lost a branch a later migration had added. Before you replace `public.agent_can_access` or `private.agent_can_access_tasks`, read every later migration that touched it and carry forward every branch. This codebase has had that failure.

**A blanket grant has no rows.** `all_projects` and `task_all_projects` are flags; `project_ids` is empty and `agent_task_grants` has nothing in it. Any code that decides access by querying the list alone denies the connection that was given everything. Check the flag first, in the database helper and in the service, both.

**The old `authorize_agent` signatures hard-code the flags false, and that is deliberate.** Someone re-authorizing through an older client must come back without a blanket grant rather than keeping one. Do not "fix" the delegation to preserve the existing flags.

**Revocation lives in `grant_id`, not in `revoked_at`.** Rotating the generation is what kills tokens already in flight. `revoked_at` is only the record. A change that sets the timestamp without rotating leaves every live token working.

**A companion session is not an agent session.** The whole distinction is whether `auth.jwt()->>'client_id'` is null. Any new destructive routine needs the companion check written into it; there is no second net. `private.agent_can_access_tasks` also requires `client_id` to be present, so a companion never reaches it at all.

**The token hook deletes `satchel_grant_id` before writing it.** That one subtraction is what stops a client supplying its own generation. Never simplify it to a plain `||` merge.

**Four constants are one deployment.** `RESOURCE` and `SUPABASE_URL` in `server/http-handler.mjs`, the audience literal inside `satchel_access_token_hook`, the default URL in `bootstrap.mjs` (now overridable with `SATCHEL_REPOSITORY_HINT_URL`), and the `.mcp.json` URL in `scripts/build-plugins.mjs`. Change one and discovery or verification breaks in a way that looks like an auth bug.

**A hook matcher and the text that describes it are one change.** `bootstrap.mjs` told the model "the authenticated Satchel hook is responsible for consuming it; repository activation does not require a model tool call" on every SessionStart source. That was true while the `mcp_tool` hook matched all four sources. Narrowing it to `clear|compact` changed `scripts/build-plugins.mjs` and left the sentence alone, so at launch the paths inverted: staging **succeeding** told the model not to call a tool and then nothing loaded, while staging **failing** was the only path that worked.

Silent in both directions. Nothing logs a hook the host skipped, and the model had been told not to look. The branch is now chosen by `event.source` as well as by whether staging worked, an unknown source counts as launch, and `tests/plugin-bootstrap.test.mjs` asserts the staged text is *unreachable* on a source the hook cannot run on.

**Rule:** the list in `bootstrap.mjs` and `mcpSessionMatcher` in `scripts/build-plugins.mjs` are the same fact written twice. Change both, and assert the pairing in a test rather than in a comment.

**spawnSync cannot be used against a server in the same process.** The test that reaches the staged branch serves the hint endpoint from the test process itself. `spawnSync` blocks that process's event loop, so the child's `fetch` never gets accepted and just waits out its 2500ms timeout, landing on the unstaged branch. It looks exactly like a staging failure, which is the branch being tested against. Use `spawn`.

**Editing a generated plugin copy works until the next build.** `integrations/claude/satchel` and `integrations/codex/satchel` are output. The source is `integrations/shared`. A fix made in one generated copy also quietly makes the two hosts behave differently.

**Sending only one prompt field is a coin flip.** Both `prompt` and `user_prompt` go out because the two hosts' documentation disagrees and one is truncated. An unsubstituted placeholder is discarded server-side, so there is no cost to keeping both.

**`${last_assistant_message}` does not substitute on Codex.** Code that assumes the assistant's reply is present will quietly capture from a half conversation there. The degradation is stated, not fixed.

**A 503 and a 403 mean different things at `/api/mcp`.** Null status is "you may not" and ends in 403; a throw is "we could not check" and ends in 503. Collapsing them turns a transient database failure into a message telling the person their connection was revoked.

**The repository hint endpoint is anonymous.** Size is checked twice, the field list is closed to three names, and the provider and repository are pattern-matched, because Vercel hands over already-parsed JSON and `Content-Length` alone controls nothing. Any new field on that bridge is a new anonymous input.

**Consent writes the grant before the approval.** Reversing it leaves a valid token with no grant row, which authenticates and then fails every call for reasons nobody can see.

**A new capability is four changes.** A column, a consent control, a branch in both access helpers, and a test that proves the denial. A capability with three of the four is a permission that is granted and never checked, or checked and never grantable.

**A green test that never saw a denial proves nothing.** `tests/security-audit.test.mjs` and `tests/agent-connections.test.mjs` exist to assert the no. Adding a positive-path test for a new capability is not coverage of it.

**Revocation cannot recall what was already read.** Both screens say so plainly. Do not write copy that implies otherwise, and do not build a feature that promises it.

**An `mcp_tool` hook cannot run at launch, ever.** It needs the session's MCP servers to be available to hooks, and `SessionStart` fires before that; the host skips it and logs "no MCP client context". `--continue` and `--resume` are launch too. This is not a timeout to tune or a matcher to widen. It is why every hook is a command script as of 0.3.0, and why anyone reintroducing an `mcp_tool` hook on a lifecycle event is reintroducing a hook that never runs on the events that matter.

**A command hook on `UserPromptSubmit` is not given the prompt.** The only documented way to reach it is `transcript_path`, which the host writes asynchronously and which may not contain the current turn when the hook fires. Retrieval was removed rather than built on that. Do not add it back as a script.

**The hook credential is not the agent's credential.** They are separate OAuth clients on purpose. Reading the host's token out of the keychain looks like a shortcut and is not: refreshing it rotates the token the host is still using, so Satchel would break the agent's own MCP connection. Two clients, two grants, two Revoke buttons.

**Refresh takes a lock.** Supabase rotates refresh tokens, so two hooks refreshing at once leave one holding a spent one. `withLock` in `auth.mjs` uses `mkdir` with a 20s stale timeout, and it has to hold the lock across the whole `await`, not just until the promise is returned.

**The transcript filter is a boundary, not a parser.** `integrations/shared/transcript.mjs` decides what leaves the machine. A `type: "user"` entry is also how a tool result arrives, so both the content shape and `toolUseResult` are checked; dropping either sends file contents and command output to a server. Anything added to what it takes is a new thing being uploaded, and `tests/transcript.test.mjs` is where that is argued.

**The local high-water mark is an optimization, not the boundary.** `classified_at` server side is the real one. Design so that losing `~/.satchel/sessions/` costs a resent message and never a duplicated memory, and never move the mark before a send succeeds.
