# Running the first foundation

Updated 16 September 2026.

The repository contains a React/TypeScript companion with GitHub sign-in through Supabase, projects, explicit memory, Supabase-native tasks, append-only handoffs, typed links, private file upload/download and task export. It uses the notebook palette and typography with responsive light/dark themes.

Memory hooks, generation-bound agent grants and the production MCP transport are implemented. Supabase-native personal/project tasks and the private bucket are deployed. Hosted rollback-only RPC checks, task-table advisors and the production read/render path pass; cleanup scheduling, a restore drill and broader signed-in browser mutation evidence remain release-hardening work.

## Local setup

Use Node.js 22.12 or later and npm:

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env.local`. These identify the project and its public browser key. Never put service-role keys, database passwords or GitHub client secrets in `VITE_*` variables; they enter the browser build. Local environment files are ignored by Git.

Without configuration, the app shows a setup-pending state and disables login. There is no simulated authentication or fake database fallback. Drafts remain in page memory during failed requests; closing the tab or signing out discards them. Offline persistence is not implemented.

## User-owned accounts and exact settings

Use a dedicated Supabase Free project with synthetic records first. Needed from the owner: project URL and publishable key, Vercel personal account/team, repository access, and the preferred region before creating any project. No billing upgrade is required by this foundation.

1. Apply every file in `supabase/migrations` in filename order using Supabase migration tooling. They are one-time migrations; an existing installation applies only migrations not already recorded. This pilot previously applied early memory migrations manually in the Dashboard, so reconcile remote migration history before `supabase db push` instead of replaying them.
2. Create the `task-files` bucket through the Storage API as private with a 6 MB file limit. From a trusted shell, set non-`VITE_*` `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, then run `npm run task-storage:provision`. Never place the service-role key in browser or Vercel public variables.
3. Run `npm run task-storage:cleanup` from a trusted scheduled environment to remove pending/failed uploads older than 24 hours and record deletion events. Start manually; schedule only after observing it against synthetic data.
4. Register a GitHub OAuth App. The callback is `https://<project-ref>.supabase.co/auth/v1/callback` (copy the real value from Supabase). Set its homepage to the stable Satchel deployment URL.
5. Enable GitHub in Supabase Authentication → Providers. Enter the GitHub client ID and secret directly in that dashboard. Satchel does not request repository scopes.
6. In Supabase URL Configuration, set the Site URL to the stable deployed app origin. Allow that exact origin and `http://127.0.0.1:5173` for development. Avoid wildcard preview origins.
7. In Vercel, import the private repository. Root is the repository root; framework is Vite. Set only the two public browser environment values, then deploy.
8. Verify memory plus task capture, edit, transition, blocker, handoff, link, file verification/download, export, agent consent/revocation and stale revision behavior against the hosted project.

GitHub account login is identity-only and separate from optional GitHub task links. Website sign-in also does not authorize agent connections; the consent interface grants memory and task read/write/upload capabilities separately.

[GitHub provider setup](https://supabase.com/docs/guides/auth/social-login/auth-github), [PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Cost and architecture

Working choice: Vite/React on Vercel, Supabase PostgreSQL/Auth/Storage and a stateless MCP endpoint. Browser and MCP requests use RLS plus narrowly scoped database functions. Supabase is the authority for memory and tasks; private Storage holds task bytes.

Vercel Hobby is intended for personal, non-commercial use. Supabase Free includes PostgreSQL and authentication allowances, but projects may pause after a week of inactivity and managed daily backups are a paid-plan feature. Use synthetic data until export/recovery is implemented; zero cost is a pilot target, not a production uptime promise. [Vercel Hobby](https://vercel.com/docs/plans/hobby), [Supabase pricing](https://supabase.com/pricing).

Satchel's implemented agent authorization follows Supabase's OAuth 2.1 server and MCP integration path. Local contract tests are not proof that fresh Codex and Claude connections work against the hosted deployment, so both hosts remain release verification gates. [OAuth server](https://supabase.com/docs/guides/auth/oauth-server).

## Checks

Pilot verification on 10 September 2026: GitHub login succeeded in the local companion. A project-load failure (`PGRST205`) revealed that the initial schema had not been applied. The foundation migration was then applied once through the hosted Supabase SQL editor, and the authenticated companion loaded successfully. A separate transaction verified project creation, memory saving, correction and deletion under the `authenticated` database role with the pilot user's JWT claims; all test data was rolled back. This verifies hosted database behavior, not a complete browser write flow or cross-device/agent integration. Dashboard application does not register the migration in CLI migration history; reconcile that history before adopting CLI-driven deployments, rather than applying this migration again.

```sh
npm test
npm run build
```

Tests execute the actual migrations in PGlite with test equivalents of Supabase identity functions. They cover memory plus task ownership, grants, generation revocation, idempotency, revision conflicts, events, handoffs, links and export. Storage API behavior, hosted advisors and real OAuth/browser flows still require hosted verification. Docker is not needed for these checks.

CI runs the same tests and build. No cloud credentials are required for CI, and CI does not deploy or migrate the database.

Named-memory checks additionally apply both migrations over an existing body-only record, verify text preservation, case-insensitive names within a project, metadata-only listing, scoped detail retrieval, optional/bounded details, rename/delete behavior, retry conflicts and authorization. The companion exposes separate Name, Description and More info fields; it fetches details only when reading or correcting a memory. The future hook/MCP contract is in [memory and storage](memory-and-storage.md).

The named-memory migration was also applied through the pilot's SQL editor on 10 September 2026. The existing saved memory remained readable, and a temporary record exercised the new browser save/read/correct/delete flow. The manually applied migrations need their CLI history reconciled before switching to CLI deployment.

11 September checkpoint: a broader browser test verified persistence, duplicate validation, two-tab conflicts, deletion cancellation, sign-out/sign-in and theme persistence. It exposed the `40001` retry loop, fixed by the third migration. All three migrations are now applied manually. Data requests also recover after 15 seconds instead of leaving the editor busy indefinitely. See [full evidence and current limits](checkpoints/web-memory-pilot-1.md).

11 September personal-memory follow-up: the fourth migration enables For me without requiring a project, preserving all existing project rows. The application now shares one editor/list and memory repository across explicit personal/project scopes. PostgreSQL tests cover accounts with zero projects, personal owner isolation, same-name records in separate scopes, immutable scope, safe retries, corrections and deletion. Four pilot migrations have now been applied through the dashboard; reconcile all four before CLI-driven deployment. See [the updated checkpoint](checkpoints/web-memory-pilot-2.md) and [feature boundaries](architecture.md).
