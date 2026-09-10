# Web memory pilot 1

Verified 10–11 September 2026 (Asia/Kolkata). Task: `gig-27f1.2`. Git checkpoint tag: `web-memory-pilot-1`.

## Usable boundary

The local companion at `http://127.0.0.1:5173/` supports GitHub sign-in, creating projects, and named memory with a required name/description and optional More info. Saved records live in hosted Supabase. Reading details, correcting/renaming a memory, and deleting it work through the real authenticated browser interface. This checkpoint is a usable local web pilot, not a deployed service or a working cross-agent integration.

## Browser acceptance results

Tests ran against the real Supabase pilot using a temporary project and memory through the Codex in-app browser. The existing user project and its saved memory were left intact. The temporary memory was deleted through the app; its empty project was removed by exact ID in the SQL editor because project deletion has no companion control yet.

| Scenario | Observed result |
|---|---|
| Create a project with a brief | Project appeared in navigation and its book opened |
| Save name, description and multiline More info | Save acknowledged, editor cleared, summary appeared |
| Required fields | Save disabled when name/description were absent |
| Duplicate name differing only in case | Clear duplicate-name error; unsaved content remained in the editor |
| In-app Reload after failed save | Draft preserved and saved records reloaded |
| Full browser reload and second tab | Session and saved project/memory recovered from the service; choose the project again after reload |
| Read More info | Full saved content appeared on request; list initially showed summary only |
| Rename and correction | Updated name, summary and details persisted with an incremented revision |
| Two tabs editing the same revision | After the fix below, stale write returned a prompt conflict; draft preserved and winning data unchanged |
| Recover from a conflict | In-app Reload showed the current revision; Read more info showed winning details alongside the retained draft; Discard draft enabled a fresh correction |
| Cancel deletion | Keep it dismissed confirmation without removing the record |
| Confirm deletion | Record removed and book returned to its empty state |
| Sign out, then GitHub sign in | Signed-out page appeared; GitHub returned to the local companion with the original user data intact |
| Light/dark mode and reload | Both layouts inspected in the narrow browser panel; selected theme persisted after the fix |
| Final cleanup | Only the user's original project/memory remained; companion left signed in, in dark mode |

## Issues found and fixed

The stale-write test originally left the editor on “Working…” indefinitely. The database functions used SQLSTATE `40001` for expected application conflicts. This matches Supabase's documented PostgREST retry-loop issue. Migration `202609110001_conflict_responses.sql` changes project and memory write conflicts to `PT409` (HTTP 409), preserving revision checks and existing grants. The real two-tab test was rerun after applying the migration and returned the expected conflict promptly. [Supabase troubleshooting](https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b).

All data requests now have a 15-second deadline and abort signal. The browser verified a timed-out save released the editor and retained the draft before the database fix was applied. A timeout does not prove a write failed: the message directs the user to reload and inspect saved state before retrying. Stable IDs and revision checks remain authoritative. Unit tests also cover a stalled request that ignores abort and a late response arriving after timeout.

Theme preference previously reset on reload. It now persists in local browser storage, with the device preference as the fallback. An initial load error no longer also displays an empty-book success state.

## Repeatable checks and database state

`npm test` passes 23 tests; `npm run build` passes TypeScript and the production Vite build. Tests exercise migrations in PostgreSQL via PGlite, including account isolation, denied agent/anonymous access, content preservation, scoped name lookup, duplicate/retry behavior, correction conflicts and deletion. These complement the manual browser acceptance checks; they do not simulate GitHub OAuth.

All three migrations were applied to the pilot through Supabase's SQL editor, in order:

1. `202609100001_foundation.sql`
2. `202609100002_named_memories.sql`
3. `202609110001_conflict_responses.sql`

Do not rerun the initial migrations against this pilot. Reconcile the CLI migration history before switching to CLI deployment. Rolling code back to the old body-only editor is not compatible with the named-memory database schema. A Git tag is a code checkpoint, not a backup of user records.

To resume locally, use the existing ignored environment configuration and `npm run dev -- --port 5173 --strictPort`. Keep that server running during OAuth. The local app depends on this machine being awake; Vercel deployment remains pending.

## Still outside this checkpoint

- Memory without a project, repository scopes and project editing/archiving/deletion UI.
- Codex/Claude plugins, hooks, MCP transport, connection grants and cross-app retrieval.
- Vercel deployment, independent phone/device verification and direct phone-chat support.
- Offline draft persistence: full browser reload, closing the tab or signing out discards unsaved drafts. In-app Reload preserves them.
- Revision history, export/recovery, automated browser CI and broad accessibility/device coverage.
- Automatic merging of concurrent edits. Compare the latest record with the retained draft before starting a fresh correction.

The next release should close the personal-memory and deployment gaps, then prove authorized hook index delivery and detail retrieval on actual agent clients. Do not mark the parent feature complete while deployment remains pending.
