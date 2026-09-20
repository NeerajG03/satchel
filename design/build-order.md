# Build order and data gaps

17 September 2026. A sequence, not a timeline. Each step leaves the app working. Routes and component shape are in [screen-map.md](screen-map.md).

## Routing

Use `react-router` (data router, `createBrowserRouter`). `vercel.json` today rewrites only `/authorize` to `index.html`. Add a catch-all rewrite for client routes that comes after the `/api` and `/.well-known` entries, so `/book`, `/tasks/:id` and the rest load on refresh in production. The `authorization_id` entry point becomes the `/apps/consent` route and stops living in `sessionStorage`. Scope for Book and Tasks is a query param so it survives reload and can be linked.

## Sequence

1. **Tokens and shell.** Add `design/tokens.css` as the app stylesheet base. Build `Shell`, `Rail`, `Header`, `Paper`, `Footer`. Hardware outer, paper inset. This alone fixes the light corners and changes every page, so it goes first. Interim: `background-clip: padding-box` on `.shell` can ship today as a one-line fix.
2. **Routes.** Route table with signed-out guard. Move the three existing views under `/book`, `/tasks`, `/apps` so nothing breaks while the new pages are built.
3. **Book.** Scope picker, collapsed composer, entries with provenance, correct in place, forget confirm, empty state with prompt chips. Footer readouts replace inline notices.
4. **Book search.** Needs the query below.
5. **Tasks list and detail.** Segments, capture composer, detail page with next action first, three-mode composer, timeline, right column. Move-to menu and the Blocked sheet with the combined call.
6. **Task edit.** Separate route. Conflict handling per the Errors board.
7. **Left off.** Actionable tasks, newest memory, apps. First-run variant when everything is empty.
8. **Projects.** List with counts, project page, empty project, new-project sheet, brief edit.
9. **Apps.** Cards, revoke in place, empty steps. Consent rework with Select all and quick start. Connected split pages.
10. **Settings.** Account, export all, forgetting.
11. **Components pass.** Focus rings, truncation, counters, reduced motion. Run [accessibility.md](accessibility.md) on every page.
12. **Remove** `Workspace.tsx`, `TaskWorkspace.tsx`, `Connections.tsx` view switch, and the old `style.css` rules they carried.

## Data gaps

What the boards show against what the code has today. "Client" means no server change.

| Drawn | Today | Needs | Step |
|---|---|---|---|
| Scope picker counts (memories per project) | Memories listed per scope on demand | A count per project, or list once and count client-side for small collections | 3 |
| Collapsed composer, prompt chips | Full form always open | Client | 3 |
| Footer readouts and live region | Inline `notice` blocks | Client | 1 |
| Book search across name, description, more info | Nothing | A search RPC or a filtered select; more info is read separately today, so searching it needs a server query | 4 |
| Search all scopes | Nothing | Same query without the scope filter | 4 |
| Revision conflict message with "Keep my text as a new draft" | Server rejects a stale revision; client shows the raw error | Client handling: detect the conflict, offer show / keep / discard | 3, 6 |
| Move to Blocked as one write | `record_task_progress` already takes `status` and `blockedReason` and moves the task in the same transaction | Client: the sheet calls `taskStore.progress` with summary = reason, status = blocked, blockedReason = reason. No new RPC. | 5 |
| Copy handoff as plain text | Handoff data exists | Client: format the latest handoff | 5 |
| Move-to menu for Ready, In progress, Done | Buttons per state | Client | 5 |
| Task edit on its own route | Edit form on the same page | Client | 6 |
| Left off: actionable tasks across all scopes, newest memory across all scopes | Lists are per scope | A cross-scope read for tasks and for the newest memory | 7 |
| Project brief edit | Brief set at create only | An update RPC for name and brief with revision | 8 |
| Project counts (memories, tasks, apps) | Not exposed | Counts in the project list read, or client-side from three lists | 8 |
| Apps with access, per project | Grants stored per connection | Reverse lookup client-side from the connections list | 8 |
| Project activity feed | Task events exist per task; memory revisions exist | A per-project activity read across tasks and memories, newest first, or v2 | 8 |
| Duplicate project name prompt | Nothing | Client check against the loaded list | 8 |
| Consent Select all / None / quick start | One checkbox per project | Client | 9 |
| "Projects you create later are not included" | True today | Copy only | 9 |
| Connected page after Allow | Redirect straight back to the app | A route the approve flow lands on before returning; the return link uses the app's redirect | 9 |
| Revoke confirm in place | Immediate revoke | Client | 9 |
| Export all (personal plus every project) | Per-project export | Loop the existing export, or one RPC | 10 |
| Verified light with "read 4 min ago" | `revoked_at` only | A last-read timestamp per connection, written by the MCP server on each index read | 9 |

Decided out of v1: dark theme, phone layouts, Skills, Resume, correction history view, delete account.

## Order of the two decided questions

- Blocked sheet: always records a progress update with status blocked and the reason as the body. One call. No checkbox.
- Settings: no delete button.
