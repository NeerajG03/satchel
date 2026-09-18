# Satchel

**Your work, with you.**

Satchel keeps your memory, projects and tasks in one place and hands them to the AI coding apps you already use. You decide what gets saved. Every app sees only what you allowed it to see, and you can revoke that any time.

The hosted pilot is at [satchel-pi.vercel.app](https://satchel-pi.vercel.app). Sign in with GitHub. It is a personal pilot, not a product with uptime promises yet.

## What it does

- **Memory.** Short named notes about how you work, in a personal book called *For me* or inside a project. Details load on demand, so the index stays small.
- **Projects.** An ongoing effort with a brief, memories, tasks and linked repositories.
- **Tasks.** Plain tasks with status, blockers, handoff notes and small file uploads. Agents can read and update them when you let them.
- **Apps.** Claude Code and Codex connect through a plugin. When a session starts, the plugin loads your memory index. Saves happen only when you ask.

## Connect Claude Code or Codex

The plugins live in the public catalog [NeerajG03/satchel-plugins](https://github.com/NeerajG03/satchel-plugins). You do not need this repository.

```sh
# Claude Code
claude plugin marketplace add NeerajG03/satchel-plugins
claude plugin install satchel@satchel
claude mcp login plugin:satchel:satchel
```

```sh
# Codex
codex plugin marketplace add NeerajG03/satchel-plugins
codex plugin add satchel@satchel
codex mcp login satchel
```

The login command opens Satchel in your browser with a consent page. Allow the scopes you want, then start a fresh session. The Apps page shows the same steps and lets you revoke access later.

The plugin holds no memory and no credentials. It is the service address, a hook that loads your index, a small bootstrap that reads the git origin so the right project is selected, and a skill that teaches the agent the tools. See [agent setup and limits](docs/agent-setup.md).

## Run your own

Satchel is a Vite and React app on Vercel with Supabase for auth, database and storage, plus a stateless MCP endpoint under `api/`. Everything is behind row level security and narrow database functions. There is no service role key in the browser or in the MCP handler.

```sh
npm ci
cp .env.example .env.local   # your Supabase URL and publishable key
npm run dev
```

```sh
npm test        # runs the real migrations in PGlite
npm run build
```

[Development setup](docs/development.md) walks through the Supabase project, GitHub OAuth app, storage bucket and Vercel deploy. [Architecture](docs/architecture.md) explains the pieces.

## Repository layout

| Folder | What is in it |
|---|---|
| `src/` | The web app |
| `api/`, `server/` | Vercel functions and the MCP server |
| `supabase/migrations/` | Schema, RLS and database functions |
| `tests/` | SQL and contract tests, run with `node --test` |
| `integrations/` | Plugin source in `shared/`, generated packages for `claude/` and `codex/` |
| `scripts/` | Build and publish the plugin catalog, storage maintenance |
| `docs/` | Product, architecture, decisions and setup. `docs/archive/` is frozen history |
| `design/` | The design system, canvas boards and their generator |

Changes to `integrations/` on `main` republish the plugin catalog automatically. See [the publish section](docs/agent-setup.md#build-and-publish).

## Where it came from

Satchel grew out of JEFF, an earlier personal context project. The older reports under `docs/archive/` are kept unchanged as a reasoning trail. They are not the current specification. Start with [the product document](docs/product.md), [the decision ledger](docs/decisions.md) and [the design notes](design/README.md).

## Platform references

- [Claude Code: plugins](https://code.claude.com/docs/en/plugins)
- [OpenAI: build plugins](https://learn.chatgpt.com/docs/build-plugins)
- [Supabase: OAuth server](https://supabase.com/docs/guides/auth/oauth-server)
