# Running the first foundation

10 September 2026 · Task authority: `gig-27f1`.

The repository now contains a React/TypeScript web foundation: GitHub sign-in through Supabase, projects, explicit memory saves, corrections with revision checks, and deletion. It uses the existing notebook palette and typography with responsive light/dark themes. The preserved mockup remains a separate artifact.

This is not the completed cross-agent feature. Native plugins, agent grants, MCP transport, hook-assisted retrieval, export/recovery, and revision-history viewing still require implementation. Database corrections replace the current content and increment its revision; this foundation does not retain past versions. The database deliberately denies tokens containing an OAuth `client_id` until agent authorization is ready.

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

1. Apply all files in `supabase/migrations` in filename order, beginning with [the foundation](../supabase/migrations/202609100001_foundation.sql) and then [named memories](../supabase/migrations/202609100002_named_memories.sql), using the SQL editor or Supabase migration tooling. These are one-time migrations, not repeatable reset scripts. Existing installations apply only migrations not already applied. The named-memory migration replaces the old write-function signatures, so reload older companion tabs after applying it.
2. Register a GitHub OAuth App. The callback is `https://<project-ref>.supabase.co/auth/v1/callback` (copy the real value from Supabase). Set its homepage to the stable Satchel deployment URL.
3. Enable GitHub in Supabase Authentication → Providers. Enter the GitHub client ID and secret directly in that dashboard. Satchel does not request repository scopes.
4. In Supabase URL Configuration, set the Site URL to the stable deployed app origin. Allow that exact origin and `http://127.0.0.1:5173` for development (the origin used by `npm run dev`). Avoid a wildcard authorizing arbitrary preview origins.
5. In Vercel, import the private `NeerajG03/satchel` repository with repository access granted. Root is the repository root; framework is Vite. Set the two public environment values for the intended environment, then deploy. The checked-in Vercel configuration builds `dist/`.
6. Use a consistent URL for sign-in tests. OAuth uses PKCE and returns to the origin that started the flow. Do not copy the callback into a different browser/device.
7. Verify sign-in, refresh, sign-out and declined login in a real browser. Then test separate accounts, cross-device reads, failed writes and stale corrections against the hosted project.

GitHub account login and future GitHub task-source access are separate. Website sign-in also does not authorize agent connections. Keep Supabase OAuth server access disabled for this first foundation; the future consent interface and per-client permissions are not present yet.

[GitHub provider setup](https://supabase.com/docs/guides/auth/social-login/auth-github), [PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Cost and architecture

Working choice: Vite/React on Vercel, Supabase PostgreSQL and Auth. Browser requests use Supabase's authenticated data API, with row-level policies and database functions enforcing account boundaries. This replaces the earlier dedicated Fastify/container starting point for the web foundation. A stateless MCP endpoint will be evaluated separately; no second authority for memory is introduced.

Vercel Hobby is intended for personal, non-commercial use. Supabase Free includes PostgreSQL and authentication allowances, but projects may pause after a week of inactivity and managed daily backups are a paid-plan feature. Use synthetic data until export/recovery is implemented; zero cost is a pilot target, not a production uptime promise. [Vercel Hobby](https://vercel.com/docs/plans/hobby), [Supabase pricing](https://supabase.com/pricing).

Supabase documents an OAuth 2.1 server and MCP integration path. That is a candidate for the agent phase, not proof that the actual Codex/Claude connections work. [OAuth server](https://supabase.com/docs/guides/auth/oauth-server).

## Checks

Pilot verification on 10 September 2026: GitHub login succeeded in the local companion. A project-load failure (`PGRST205`) revealed that the initial schema had not been applied. The foundation migration was then applied once through the hosted Supabase SQL editor, and the authenticated companion loaded successfully. A separate transaction verified project creation, memory saving, correction and deletion under the `authenticated` database role with the pilot user's JWT claims; all test data was rolled back. This verifies hosted database behavior, not a complete browser write flow or cross-device/agent integration. Dashboard application does not register the migration in CLI migration history; reconcile that history before adopting CLI-driven deployments, rather than applying this migration again.

```sh
npm test
npm run build
```

Tests execute the actual migration in PGlite's PostgreSQL engine with test equivalents of Supabase's identity functions. They check account isolation, foreign-project writes, anonymous/agent denial, safe save retries, immutable metadata, conflicting corrections and deletion. They do not replace hosted Supabase or real GitHub OAuth tests. Docker is not needed for these checks.

CI runs the same tests and build. No cloud credentials are required for CI, and CI does not deploy or migrate the database.

Named-memory checks additionally apply both migrations over an existing body-only record, verify text preservation, case-insensitive names within a project, metadata-only listing, scoped detail retrieval, optional/bounded details, rename/delete behavior, retry conflicts and authorization. The companion exposes separate Name, Description and More info fields; it fetches details only when reading or correcting a memory. The future hook/MCP contract is in [memory and storage](memory-and-storage.md).

The named-memory migration was also applied through the pilot's SQL editor on 10 September 2026. The existing saved memory remained readable, and a temporary record exercised the new browser save/read/correct/delete flow. Both manually applied migrations need their CLI history reconciled before switching to CLI deployment. Personal memory without a project remains unimplemented.
