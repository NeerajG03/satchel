# Web memory pilot 2 — personal memory

Verified 11 September 2026 (Asia/Kolkata). Task: `gig-27f1.3`. Git checkpoint tag: `web-memory-pilot-2`.

## Usable boundary

The local companion now opens in **For me**. Personal memory needs no project, and project memory remains available in the same sidebar. Both destinations use the same name, description and More info editor, summary index, scoped-name retrieval, revision-checked correction and deletion. This extends [pilot 1](web-memory-pilot-1.md); deployment and native agent integration are still pending.

The editor shows its save destination. An unsaved memory draft disables scope switching until saved or discarded. Identical names in personal and project memory resolve independently. No automatic copying or union of those scopes occurs.

## Browser acceptance

| Check | Result |
|---|---|
| Default screen and repeated For me selection | Personal editor available immediately; no forced project creation or stuck loading state |
| Personal save | Saved a temporary personal `definition` record even though the user's project already had that name |
| Duplicate personal name differing only in case | Error shown; name/description draft retained; scope navigation blocked while the draft existed |
| Existing project record | Original `definition` summary and revision 4 remained unchanged after migration and personal writes |
| Project save through shared components | Temporary project record saved independently |
| Full browser reload | Returned to For me; saved personal record persisted |
| Personal correction | Loaded full personal details, renamed the record, corrected all three fields and advanced its revision to 2 |
| Same name in two scopes | Renamed personal record to match the temporary project record; descriptions and details remained distinct |
| Personal delete | Removed personal record only; same-named project record remained readable |
| Project read and cleanup | Retrieved the project-specific details, then deleted only the temporary project record |
| Final state | Temporary records removed, original project memory intact, app left signed in on For me |

The browser used the existing pilot account. The zero-project account case and cross-owner boundaries were verified by database tests rather than creating another live login account.

## Code structure

The former single-file memory implementation is separated into explicit modules:

- `src/main.tsx`: authentication, theme and application shell.
- `src/Workspace.tsx`: active scope, asynchronous state and draft coordination.
- `src/features/memories/model.ts`: personal/project scope union, content types, limits and summary projection.
- `src/features/memories/repository.ts`: list/read/save/correct/delete with injected database client, stable-ID checks and request deadlines.
- `src/features/memories/MemoryEditor.tsx` and `MemoryList.tsx`: shared controlled UI components without database queries.
- `src/features/projects/repository.ts` and `ScopeSidebar.tsx`: project operations and scope navigation.

Adding future scope types requires an explicit domain case and schema/access changes; the code does not treat unknown scopes as personal. There is no generic plugin framework or speculative workflow engine. Agent transports will need connection grants against the same underlying authority, not a reused companion login.

## Database and checks

Migration `202609110002_personal_memory.sql` was applied through the pilot's Supabase SQL editor after the three migrations recorded in pilot 1. It makes `project_id` nullable, adds per-owner personal-name uniqueness and updates the shared list/read functions to match an explicit null scope. Existing project foreign keys, policies and write-function signatures are preserved. Existing rows and revisions are unchanged; there is no personal placeholder project.

All **32 tests pass**, and the production build passes TypeScript and Vite. New PostgreSQL tests cover zero-project accounts, unchanged project records, scoped names, personal read/write/retry/correction/deletion, owner isolation, denied anonymous/agent access, and preventing moves through ID reuse or direct scope updates. Earlier migration, conflict and timeout tests remain passing.

There are now four manually applied pilot migrations. Reconcile CLI migration history before adopting CLI deployments; do not rerun the initial migrations. The Git tag snapshots code and documentation, not user records. Resume with the existing ignored environment configuration and `npm run dev -- --port 5173 --strictPort`.

## Remaining work

Vercel deployment and independent-device testing are next. Native agent plugins/hooks/MCP, connection grants, repository scopes, moving memories between scopes, export/recovery, revision history and offline drafts remain pending. Full browser reload/sign-out still discards unsaved drafts; in-app Reload preserves them. The local companion needs the development server and this laptop to stay available.
