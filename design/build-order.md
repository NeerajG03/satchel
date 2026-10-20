# Build order and data gaps

17 September 2026, tasks removed 20 October 2026. A sequence, not a timeline. Each step leaves the app working. Routes and component shape are in [screen-map.md](screen-map.md).

## Routing

Use `react-router` (data router, `createBrowserRouter`). `vercel.json` today rewrites only `/authorize` to `index.html`. Add a catch-all rewrite for client routes that comes after the `/api` and `/.well-known` entries, so `/book`, `/topics/:id` and the rest load on refresh in production. The `authorization_id` entry point becomes the `/apps/consent` route and stops living in `sessionStorage`. Scope for the Book is a query param so it survives reload and can be linked.

## Sequence

1. **Tokens and shell.** Add `design/tokens.css` as the app stylesheet base. Build `Shell`, `Rail`, `Header`, `Paper`, `Footer`. Hardware outer, paper inset. This alone fixes the light corners and changes every page, so it goes first. Interim: `background-clip: padding-box` on `.shell` can ship today as a one-line fix.
2. **Routes.** Route table with signed-out guard. Move the three existing views under `/book`, `/apps` so nothing breaks while the new pages are built.
3. **Book.** Scope picker, collapsed composer, entries with provenance, correct in place, forget confirm, empty state with prompt chips. Footer readouts replace inline notices.
4. **Book search.** Needs the query below.
5. **Left off.** Newest memory, apps. First-run variant when everything is empty.
6. **Topics.** List with counts, project page, empty project, new-project sheet, brief edit.
7. **Apps.** Cards, revoke in place, empty steps. Consent rework with Select all and quick start. Connected split pages.
8. **Settings.** Account, forgetting.
9. **Components pass.** Focus rings, truncation, counters, reduced motion. Run [accessibility.md](accessibility.md) on every page.
10. **Remove** `Workspace.tsx`, `Connections.tsx` view switch, and the old `style.css` rules they carried.

## Data gaps

What the boards show against what the code has today. "Client" means no server change.

| Drawn | Today | Needs | Step |
|---|---|---|---|
| Scope picker counts (memories per project) | Memories listed per scope on demand | A count per project, or list once and count client-side for small collections | 3 |
| Collapsed composer, prompt chips | Full form always open | Client | 3 |
| Footer readouts and live region | Inline `notice` blocks | Client | 1 |
| Book search across name, description, more info | Nothing | A search RPC or a filtered select; more info is read separately today, so searching it needs a server query | 4 |
| Search all scopes | Nothing | Same query without the scope filter | 4 |
| Revision conflict message with "Keep my text as a new draft" | Server rejects a stale revision; client shows the raw error | Client handling: detect the conflict, offer show / keep / discard | 3 |
| Left off: newest memory across all scopes | Lists are per scope | A cross-scope read for the newest memory | 5 |
| Project brief edit | Brief set at create only | An update RPC for name and brief with revision | 6 |
| Topic counts (memories, apps) | Not exposed | Counts in the topic list read, or client-side from the lists | 6 |
| Apps with access, per project | Grants stored per connection | Reverse lookup client-side from the connections list | 6 |
| Topic activity feed | Memory revisions exist | A per-topic activity read across memories, newest first, or v2 | 6 |
| Duplicate project name prompt | Nothing | Client check against the loaded list | 6 |
| Consent Select all / None / quick start | One checkbox per project | Client | 7 |
| "Projects you create later are not included" | True today | Copy only | 7 |
| Connected page after Allow | Redirect straight back to the app | A route the approve flow lands on before returning; the return link uses the app's redirect | 7 |
| Revoke confirm in place | Immediate revoke | Client | 7 |
| Verified light with "read 4 min ago" | `revoked_at` only | A last-read timestamp per connection, written by the MCP server on each index read | 7 |

Decided out of v1: dark theme, phone layouts, Skills, Resume, correction history view, delete account, export. Tasks are removed from Satchel.

## The decided question

- Settings: no delete button.
