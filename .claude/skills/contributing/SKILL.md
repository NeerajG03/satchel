---
name: contributing
description: Use at the start of any Satchel task. Explains how the repo is laid out, how a change travels from migration to UI to plugin, which commands must pass, what to update in docs, and the commit rules. Points to the design and security skills for their areas.
---

# Contributing to Satchel

Start here for any change. Then read the `design` skill for anything visible and the `security` skill for anything that touches data, auth, the MCP server or the plugin.

## What Satchel is

A hosted home for a person's memory, projects and tasks, handed to the AI coding apps they use through a plugin. Explicit saves only. Every app sees only what it was allowed to see. `README.md` and `docs/product.md` say more. `docs/decisions.md` is the product ledger and `design/decisions.md` is the design ledger. Read the relevant rows before proposing something that looks like it was already settled.

## Layout

| Where | What | Notes |
|---|---|---|
| `supabase/migrations/` | Schema, RLS, functions | Append only. Never edit an applied migration. Name with a timestamp prefix. |
| `server/` | MCP server, services, token check | Plain `.mjs`, runs on Vercel functions |
| `api/` | Vercel entry points | Thin. Logic lives in `server/` |
| `src/app/` | Routes, auth, scope, loading, stores | |
| `src/features/<feature>/` | model, repository, pages | Pages never build queries. Repositories get the client passed in. |
| `src/ui/`, `src/shell/`, `src/styles/` | Shared pieces, frame, CSS | Tokens are copied from `design/tokens.css` |
| `integrations/shared/` | Plugin source: bootstrap, hooks, skill | Edit here only |
| `integrations/claude/`, `integrations/codex/` | Generated packages | Never edit by hand |
| `.claude-plugin/`, `.agents/plugins/` | Marketplace files | Generated |
| `tests/` | `node --test`, runs real migrations in PGlite | No cloud needed |
| `docs/`, `design/` | Product, architecture, design system | Keep them current |

## How a change travels

```
 migration  ──►  service (server/*.mjs)  ──►  MCP tool (server/mcp-server.mjs)
     │                                            │
     └──►  repository (src/features/*/repository.ts)  ──►  page  ──►  copy + board
                                                                          │
 plugin change: integrations/shared  ──►  npm run plugins:build  ──►  commit generated files
```

Do all the steps a change needs. A new task field, for example, needs the migration, the service, the tool schema, the repository type, the page, the copy deck, and a test.

## Before you push

```sh
npm test
npm run build
```

Both must pass. `npm run build` type checks first. If you touched `integrations/shared/`, also run `npm run plugins:build` and bump the version in `scripts/build-plugins.mjs`, then commit the generated packages and marketplace files. Installs read them straight from `main`. Run `claude plugin validate .` to check the marketplace.

Migrations in the hosted pilot are applied by hand through the Supabase SQL editor. Say so in the PR when a change needs one. CI does not migrate.

## Docs to update with the code

- A new or changed user-facing string: `design/copy.md`, and `design/canvas/gen.mjs` if it is on a board.
- A settled choice that changes: a new row at the top of `docs/decisions.md` or `design/decisions.md`.
- A new tool or grant rule: `docs/memory-and-storage.md` or `docs/tasks-and-handoffs.md`.
- Plugin behaviour: `docs/agent-setup.md`.

## Commits and pull requests

- Small, focused commits. Plain-language subject in the imperative, under 70 characters, saying what changed for the user or the code. Body only when the why is not obvious.
- No AI co-author lines and no "generated with" lines in commits or PR text. This is a firm rule for this repo.
- Stage files by path. Do not stage `.DS_Store` files, `.env*`, or stray screenshots.
- Do not commit anything that contains a key, token or real user data.
- Branch from `main`, open a PR, and describe what changed, what you tested, and whether a migration must be applied by hand.

## Style

- TypeScript in `src/`, plain ES modules in `server/`, `api/`, `scripts/` and `tests/`.
- Keep the existing compact style in a file rather than reformatting it.
- Comments only where the why is not visible from the code. No commented-out code.
- Errors are mapped to plain sentences for the user. Never show a raw database error on a page.
