# Skills delivery: low-level design

15 September 2026. Implements [skills delivery requirements](skills-delivery.md). Scope is the **local** surfaces: Claude Code CLI and desktop, Codex CLI and ChatGPT desktop, served from one private Git repository. Cloud delivery stays out until the routes in section 6 of the requirements are researched; nothing here forecloses them, and section 5 below is the reason a release also produces an archive.

Existing conventions this follows: the UI never builds queries, repositories receive their Supabase client explicitly, row-level security stays authoritative, definer functions exist only where a grant boundary is crossed, and writes are idempotent on a client-supplied UUID. See [architecture](architecture.md).

## 1. Module boundaries

| Path | Responsibility |
|---|---|
| `supabase/migrations/2026091600xx_skills.sql` | Tables, constraints, policies, functions, grants |
| `src/features/skills/model.ts` | Target union, content types, field limits, kebab-name validation |
| `src/features/skills/repository.ts` | Skill and kit reads/writes, release listing, publish call |
| `src/features/skills/SkillEditor.tsx` | One controlled editor for name, description and body |
| `src/features/skills/SkillList.tsx` | Summary display, body on demand, correct and delete |
| `src/features/skills/KitPanel.tsx` | Per-target selection, unpublished-change state, publish, setup and update commands |
| `src/features/skills/DeliverySetup.tsx` | GitHub App connect flow and its honest state rows |
| `src/Shelf.tsx` | Coordinates shelf scope and draft lifecycle, sibling to `Workspace.tsx` |
| `server/release-builder.mjs` | Pure: selection plus target plus version to file tree and checksum. No network |
| `server/github-app.mjs` | App JWT, installation token, tree/commit/tag calls. Injectable fetch |
| `server/skills-service.mjs` | Request-scoped Supabase adapter, mirroring `memory-service.mjs` |
| `server/skills-handler.mjs` | Companion-token verification, connect and publish handlers |
| `api/skills-connect.mjs`, `api/skills-publish.mjs` | Vercel function entry points |

Agent MCP connections get **no** access to skills in this design. The shelf is companion-only, so there are no new agent grants, no new MCP tools, and no change to the memory surface.

## 2. Data model

`skills.source_id` being null means the skill is authored in Satchel. `skill_sources` therefore holds only repo sources, which removes the need for a shape constraint on the source row itself.

```
skill_sources   id, owner_id, provider, repository, commit_sha, created_at
                repository lowercase and matching ^[a-z0-9_.-]+/[a-z0-9_.-]+$
                commit_sha matching ^[0-9a-f]{40}$ when resolved

skills          id, owner_id, source_id (null = authored here), source_path,
                name, description, body, revision, created_at, updated_at
                name lowercase kebab, ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$
                description 1..280, body 0..40000
                unique (owner_id, name)
                check (source_id is null) = (source_path is null)

skill_tags      owner_id, skill_id, project_id          organizational only

skill_kit_items owner_id, target, skill_id              target in claude-code, codex

skill_releases  id, owner_id, target, version, manifest jsonb, files jsonb,
                checksum, commit_sha, archive_sha256, created_at, delivered_at
                unique (owner_id, target, version)

skill_delivery  owner_id pk, provider, repository, installation_id,
                branch, connected_at, revoked_at
```

`name` is deliberately the single identifier. It is the directory name, the SKILL.md frontmatter name, and therefore the invocation name, so a separate display title would only create two things that can disagree. `name` plus `description` plus `body` is the same three-field shape as a memory, which is the point.

Policies mirror the existing companion policies exactly: `owner_id = (select auth.uid())` and `(select auth.jwt()->>'client_id') is null`, so an agent OAuth token is denied at the database. Grants are per column, and `revision` and `updated_at` stay untouchable by clients, stamped by a trigger copied from `stamp_memory_revision`.

`files` is jsonb of path to content. A release therefore carries its own frozen bytes, which is what makes it survive an upstream source disappearing. At 40 KB a skill this is comfortable on the Supabase free tier for a personal pilot, and it is the thing to watch if the shelf grows large.

### Functions

| Function | Security | Purpose |
|---|---|---|
| `save_skill(id, source_id, source_path, name, description, body)` | invoker | Insert on conflict do nothing, then compare the stored row to the request and raise `40001` on mismatch. Same retry contract as `save_memory` |
| `correct_skill(id, revision, name, description, body)` | invoker | Update guarded on revision, raise `40001` when it moved |
| `list_skills()` | invoker, stable | Names, descriptions, source and revision only. No bodies |
| `read_skill(name)` | invoker, stable | Body on demand, raises `P0002` when missing or renamed |
| `set_kit_item(target, skill_id, included bool)` | invoker | Idempotent tick and untick |
| `open_skill_release(id, target, manifest, files, checksum)` | invoker | Allocates `version` as max plus one for that owner and target, idempotent on `id`. A concurrent publish loses the unique index and the caller retries |
| `finish_skill_release(id, commit_sha, archive_sha256)` | invoker | The only way `commit_sha` is ever set. Releases are otherwise immutable |
| `connect_skill_delivery(repository, installation_id)` | definer | Writes `skill_delivery` only after the handler has verified installation ownership. Not callable usefully from the browser alone |

## 3. Generated repository layout

One repository, both hosts, one plugin directory per kit.

```
satchel-kit/
├── README.md                              generated, states that hand edits are overwritten
├── .claude-plugin/marketplace.json        Claude Code reads this
├── .agents/plugins/marketplace.json       Codex reads this
├── claude-code/
│   ├── .claude-plugin/plugin.json         name satchel-skills, version 0.0.<release>
│   └── skills/<name>/SKILL.md
└── codex/
    ├── plugin.json                        portable root manifest, extensions.com.openai
    ├── .claude-plugin/plugin.json          compatibility manifest
    └── skills/<name>/SKILL.md
```

Both marketplaces use top-level name `satchel-kit` and plugin name `satchel-skills`, so the install handle is `satchel-skills@satchel-kit` on both hosts. That avoids colliding with the existing `satchel@satchel-dev` memory package. `satchel-kit` is not on Claude Code's reserved marketplace name list.

The Codex entry carries `policy.installation`, `policy.authentication` and `category`, which its docs require and Claude's schema does not have. That is why the two marketplace files are written separately instead of sharing one.

`version` is bumped on every release, as `0.0.<release version>`. Claude Code only ships an update when that field changes, and the repo's own history already showed stale cached hooks when a version was left alone.

Each `SKILL.md` is frontmatter `name` and `description`, then the body. A repo-sourced skill's supporting files are copied alongside when repo sources land; the builder already takes a file map rather than a single string so that needs no rework.

## 4. Release build

`release-builder.mjs` is pure and is the first thing to be tested, because everything downstream depends on its output being stable.

```
buildRelease({skills, target, version}) -> {files, checksum}

  files    Map of repo-relative path to UTF-8 string, sorted by path
  checksum sha256 over a canonical serialization: for each path in sorted
           order, the path, a null byte, the byte length, a null byte, the
           content. Sorting and explicit lengths keep it independent of
           object key order and free of delimiter ambiguity
```

Determinism matters twice: the checksum has to be reproducible for a given selection, and the archive in section 5 has to be byte-stable. So the builder embeds no timestamps and no random values, and the archive writer uses a fixed modification time.

## 5. Archive

The same file map is written to a store-only zip with fixed timestamps, so the bytes and therefore the sha256 are a function of the selection alone. Its sha256 is recorded on the release.

This is built after the Git path works, because every consumer of it is currently an unverified cloud route plus Claude Code's own `archive` marketplace source and `--plugin-url`. It exists so those routes need no rebuild, not because it is on the critical path.

Zip writing needs either a small dependency or roughly sixty lines of store-only writer. Given this repository runs on five runtime dependencies, I lean to writing it, but that is a call to make when we get there rather than now.

## 6. GitHub App

### Registration and connect

Registering the App is a one-time owner action, documented rather than automated. Requested permission is Contents read and write, nothing else.

The user creates the empty private repository themselves, prefilled by a link, then installs the App on that one repository. Satchel does **not** create the repository, because repository creation would need a much broader permission than Contents, and the whole point of the App over an OAuth `repo` scope is that it stays narrow.

Install returns the browser to the SPA with `installation_id`. The browser cannot be believed about that value: an `installation_id` it does not own would otherwise let it write to someone else's repositories. So connect is server-side and verifies two things before writing anything:

1. `GET /app/installations/{installation_id}` and compare `account.login` to the signed-in user's GitHub login, taken from their Supabase identity, case-insensitively.
2. `GET /installation/repositories` with the installation token and confirm the claimed repository is in it.

Only then does `connect_skill_delivery` record the row. Both checks failing closed is the security boundary of this whole feature.

### Tokens

`jose` is already a dependency, so the App JWT is an RS256 sign with `iss` as the App ID and a short expiry, exchanged at `POST /app/installations/{id}/access_tokens` for an installation token good for about an hour. Tokens are minted per request and never stored.

### Writing a release

One tree, one commit, one tag.

```
GET  /repos/{o}/{r}/git/ref/heads/{branch}          current head, or empty repo
POST /repos/{o}/{r}/git/trees                       full file list, entries carry
                                                    content inline so no separate
                                                    blob calls, and base_tree is
                                                    omitted so removed skills
                                                    disappear instead of lingering
POST /repos/{o}/{r}/git/commits                     parent = head when it exists
PATCH /repos/{o}/{r}/git/refs/heads/{branch}        fast-forward
POST /repos/{o}/{r}/git/refs                        refs/tags/<target>-v<version>
```

Omitting `base_tree` is the important detail. It makes the commit a full replacement of the tree, so unticking a skill actually removes its files rather than leaving them behind.

## 7. Publish endpoint

`POST /api/skills/publish` with the user's Supabase session JWT.

Token verification is a sibling of `verifyAgentToken`, not a reuse of it. The agent verifier *requires* `client_id` and `satchel_grant_id`; the companion verifier must **reject** a token carrying `client_id`, matching the row-level policies. Getting that inversion wrong would let an agent grant publish, so it gets its own test.

Sequence, with the failure story for each step:

```
1. verify companion token            401, nothing written
2. read kit and skills under RLS     403 when the connection is revoked
3. buildRelease                      pure, cannot partially apply
4. open_skill_release                reserves the version; a concurrent publish
                                     loses the unique index and the client retries
                                     the same release id with the same payload
5. commit + tag on GitHub            release row exists without commit_sha.
                                     This is the uncertain outcome, and it is
                                     reported as uncertain, never as published
6. finish_skill_release              the only transition to published
```

Retrying step 5 is safe: the tree and commit are content-addressed, and an existing tag is treated as already done. A retry reuses the same release id and payload, exactly as an uncertain `save_memory` does today.

## 8. Interface state

Four rows, never collapsed into one, matching R13 and R14.

| Row | Source of truth |
|---|---|
| On the shelf | Satchel database, with source and revision |
| In a published kit | Release version, checksum and commit |
| Delivered to a surface | **Not observable.** GitHub serves the clone, so the panel says so rather than guessing |
| Can run there | Not knowable. Skills carrying scripts are marked as needing setup where they run |

The third row is the honest cost of choosing Git as the transport, and it is worth stating in the UI rather than hiding. The optional version-reporting hook that would turn it into evidence is recorded as open in the requirements, not designed here.

Setup text is generated per host and includes the private-repo refresh caveat: a background refresh in Claude Code disables git credential helpers, so the SSH remote is offered first, with `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1` as the alternative.

## 9. Tests

Following the existing PGlite plus `node --test` harness, which runs the real migration with test equivalents of Supabase's identity functions.

| File | Covers |
|---|---|
| `tests/skills-database.test.mjs` | Owner isolation, agent-token denial, kebab and length constraints, unique names, kit ticking, revision stamping, conflicting corrections, release immutability, version allocation under a concurrent insert, safe publish retry |
| `tests/release-builder.test.mjs` | Byte-identical output for the same selection, checksum stability, both marketplace shapes, version bump, and that unticking removes files from the tree |
| `tests/github-app.test.mjs` | JWT claims, token exchange, the tree/commit/tag call sequence, empty-repository first commit, existing-tag retry, all against an injected fetch |
| `tests/skills-handler.test.mjs` | Companion token accepted, agent token rejected, installation-ownership check rejecting a mismatched login and a repository outside the installation, uncertain-commit reported as uncertain |

No test reaches real GitHub or real Supabase. The acceptance loop in the requirements is the manual counterpart and the only thing that can claim a host actually installed anything.

## 10. Build order

1. Migration and `skills-database` tests.
2. `release-builder` and its tests. Pure, no network, and everything depends on it.
3. Shelf UI for skills and kits, usable with delivery not yet connected.
4. `github-app`, connect and publish handlers, and their tests.
5. Generated setup text and the four state rows.
6. Archive writer and `archive_sha256`.
7. Run the acceptance loop on real accounts and write a checkpoint recording what actually happened, including failures.

Steps 1 to 3 deliver a shelf that works on its own. Nothing reaches an agent until step 4, and nothing may be described as installed until step 7.

## 11. Configuration

New deployment values, none of them `VITE_` prefixed, because `VITE_` variables enter the browser bundle:

| Name | Purpose |
|---|---|
| `SATCHEL_GITHUB_APP_ID` | App identifier for the JWT `iss` |
| `SATCHEL_GITHUB_APP_PRIVATE_KEY` | RS256 signing key. Server only, never logged |
| `SATCHEL_GITHUB_APP_SLUG` | Builds the install URL shown in the companion |

The publish handler holds no service-role key, exactly as the MCP handler does not. Everything it reads and writes in Satchel goes through the user's own token under row-level security.
