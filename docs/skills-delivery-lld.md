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

Satchel stores no skill content. `skills` is a cache of what a source repository contains, kept so the shelf can be browsed and chosen from without fetching on every page load.

```
skill_sources   id, owner_id, provider, repository, commit_sha, is_delivery_target,
                synced_at, created_at
                repository lowercase, ^[a-z0-9_.-]+/[a-z0-9_.-]+$
                commit_sha ^[0-9a-f]{40}$
                exactly one row per owner may have is_delivery_target true

skills          id, owner_id, source_id, path, name, description, seen_sha, synced_at
                name lowercase kebab, ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$
                description 0..280, truncated from frontmatter for display
                unique (owner_id, source_id, name)
                NO body column. That is the point

skill_tags      owner_id, skill_id, project_id                organizational only

skill_kit_items owner_id, target, skill_id                    target in claude-code, codex

skill_releases  id, owner_id, target, version, manifest jsonb, files jsonb,
                generated_paths text[], checksum, commit_sha, archive_sha256,
                created_at, delivered_at
                unique (owner_id, target, version)

skill_delivery  owner_id pk, provider, repository, installation_id, branch,
                connected_at, revoked_at
```

`name` is the only identifier. It is the directory name under `skills/`, the SKILL.md frontmatter name, and therefore the invocation name, so a separate display title would only create two things that can disagree.

`generated_paths` is load-bearing. It is how the next publish knows which paths it owns, and therefore which it may delete. Without it a publish cannot safely distinguish its own previous output from the user's source files.

Because content is not stored, a skill has no revision integer. Its version is the commit it was read at, which is what `seen_sha` records. A skill whose `seen_sha` differs from its source's current `commit_sha` is shown as changed since sync.

Policies mirror the existing companion policies exactly: `owner_id = (select auth.uid())` and `(select auth.jwt()->>'client_id') is null`, so an agent OAuth token is denied at the database. That is the enforcement behind S11, not just an absence of tools.

### Functions

| Function | Security | Purpose |
|---|---|---|
| `add_skill_source(id, repository, is_delivery_target)` | invoker | Idempotent on `id`, same retry contract as `save_memory` |
| `sync_skill_source(source_id, commit_sha, skills jsonb)` | invoker | Replaces the cached skill rows for one source in one statement. Kit membership survives by `(source_id, name)`, so a re-sync does not silently drop a selection |
| `list_skills()` | invoker, stable | Names, descriptions, source and sync state. There is no body to withhold |
| `set_kit_item(target, skill_id, included)` | invoker | Idempotent tick and untick |
| `open_skill_release(id, target, manifest, files, checksum, generated_paths)` | invoker | Allocates `version` as max plus one for that owner and target, idempotent on `id` |
| `finish_skill_release(id, commit_sha, archive_sha256)` | invoker | The only way `commit_sha` is ever set |
| `connect_skill_delivery(repository, installation_id)` | definer | Written only after the handler verifies installation ownership |

## 3. Generated repository layout

One repository. The user's source at the top, Satchel's output below it, and a README that says which is which.

```
my-skills/
├── skills/<name>/SKILL.md            ← YOURS. Satchel reads, never writes on publish
│                                       (it does write here for companion authoring)
├── README.md                          ← generated
├── .claude-plugin/marketplace.json    ← generated, Claude Code reads
├── .agents/plugins/marketplace.json   ← generated, Codex reads
├── claude-code/                       ← generated
│   ├── .claude-plugin/plugin.json
│   └── skills/<name>/SKILL.md         ← real copy, deduplicated to one Git blob
└── codex/                             ← generated
    ├── plugin.json                     (portable manifest, the only one)
    └── skills/<name>/SKILL.md
```

Two refinements settled while building this:

**Each marketplace file lists only its own host's plugin.** Claude's names `./claude-code`, Codex's names `./codex`. Listing both in each would let a host install the other host's subset. A target that has never been published is left out of its marketplace entirely, because an entry pointing at a missing directory is at best skipped by Codex and unspecified for Claude.

**Codex gets one manifest, not two.** The portable root `plugin.json` is OpenAI's documented preferred form, and its rule is that an inline `extensions.com.openai` object *replaces* rather than merges a `.codex-plugin/plugin.json` overlay. A second Claude-compatible manifest in the same directory would add ambiguity for no gain, so it is not written.

`skills/<name>/SKILL.md` is the layout `npx skills add <owner/repo> --skill <name>` consumes, so the source half of this repository stays usable by other tools and by the user directly if Satchel is not involved. The exact layout the Vercel CLI expects is worth confirming from `vercel-labs/skills` before the first release, since its documentation gives the commands but not the directory contract.

Both marketplaces use top-level name `satchel-kit` and plugin name `satchel-skills`, so the install handle is `satchel-skills@satchel-kit` on both hosts. That avoids colliding with the existing `satchel@satchel-dev` memory package, and `satchel-kit` is not on Claude Code's reserved marketplace name list.

Neither plugin directory contains `mcp.json`, `.mcp.json` or `.app.json`, and the builder has no code path that could emit one. Per R11a, a plugin declaring MCP servers is marked Desktop only by OpenAI, so an accidental MCP declaration here would silently restrict every skill in the kit. `tests/release-builder.test.mjs` asserts the absence.

The Codex entry carries `policy.installation`, `policy.authentication` and `category`, which its docs require and Claude's schema does not have. That is why the two marketplace files are written separately instead of sharing one.

`version` is bumped on every release, as `0.0.<release version>`. Claude Code only ships an update when that field changes, and the repo's own history already showed stale cached hooks when a version was left alone.

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

Registering the App is a one-time owner action, documented rather than automated. Requested permission is Contents read and write, nothing else. Read is needed to discover skills in a source repository; write is needed for the generated paths and for companion authoring.

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

`base_tree` is the important detail, and it is the opposite of what a dedicated delivery repository would want. Here the repository also holds the user's `skills/` source, so the commit **must** start from the current tree and change only Satchel's own paths.

Generated paths split in two, which is what makes the deletion rule safe:

| Class | Paths | Rule |
|---|---|---|
| Shared | `README.md`, both `marketplace.json` files | Rewritten on every publish. **Never deleted**, because neither target owns them |
| Target-owned | everything under `<target>/` | Rewritten, and a path the previous release of *this* target had but this one does not is deleted |
| Everything else | `skills/`, `LICENSE`, the user's own files | Never written, never deleted, never consulted |

```
base_tree   = current head tree
write       = every path in this release's generated_paths
delete      = previous generated_paths, filtered to this target's prefix,
              minus this release's paths   (tree entry with sha null)
```

Filtering deletions to the target prefix is the whole safety property. Without it, publishing the Claude kit could delete Codex's directory, or worse, a shared path or the user's `skills/`. `tests/release-builder.test.mjs` asserts directly that a previous path list containing `skills/**`, `LICENSE` and the other target's files yields no deletions at all.

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
| `tests/release-builder.test.mjs` | Byte-identical output for the same selection, checksum path/length sensitivity and key-order insensitivity, both marketplace shapes, omission of an unpublished target, version bump, verbatim skill content, absence of any MCP or app declaration, and that a deletion can never escape the target prefix |
| `tests/github-app.test.mjs` | JWT claims, token exchange, the tree/commit/tag call sequence, empty-repository first commit, existing-tag retry, all against an injected fetch |
| `tests/skills-handler.test.mjs` | Companion token accepted, agent token rejected, installation-ownership check rejecting a mismatched login and a repository outside the installation, uncertain-commit reported as uncertain |

No test reaches real GitHub or real Supabase. The acceptance loop in the requirements is the manual counterpart and the only thing that can claim a host actually installed anything.

## 10. Build order

1. Migration and `skills-database` tests.
2. `release-builder` and its tests. Pure, no network, and everything depends on it.
3. `github-app`: App JWT, installation token, source reading, and the generated-path-only commit, with its tests against an injected fetch.
4. Connect and publish handlers, and their tests.
5. Shelf UI: sources, skills, kits, publish, generated setup text and the four state rows.
6. Archive writer and `archive_sha256`.
7. Run the acceptance loop on real accounts and write a checkpoint recording what actually happened, including failures.

The ordering changed when skill content moved out of Satchel: reading a repository is now on the critical path, so `github-app` comes before the UI rather than after it. Nothing may be described as installed until step 7.

## 11. Configuration

New deployment values, none of them `VITE_` prefixed, because `VITE_` variables enter the browser bundle:

| Name | Purpose |
|---|---|
| `SATCHEL_GITHUB_APP_ID` | The JWT `iss`. GitHub's App page now says "Using your App ID to get installation tokens? You can now use your Client ID instead", and either value works here because the signer only stringifies it. Prefer the Client ID, since that is the direction GitHub is steering |
| `SATCHEL_GITHUB_APP_PRIVATE_KEY` | RS256 signing key. Server only, never logged. GitHub issues PKCS#1 (`BEGIN RSA PRIVATE KEY`); `createPrivateKey` accepts that and PKCS#8, so either works |
| `SATCHEL_GITHUB_APP_SLUG` | Builds the install URL shown in the companion |

### Registering the App

A one-time owner action. Under **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**:

| Field | Value |
|---|---|
| Name | Satchel Skills, or any unused name. The resulting slug goes in `SATCHEL_GITHUB_APP_SLUG` |
| Homepage URL | `https://satchel-pi.vercel.app` |
| Setup URL | `https://satchel-pi.vercel.app` , with **Redirect on update** enabled. GitHub returns the browser here with `installation_id` and `setup_action` after an install |
| Webhook | **Uncheck Active.** Nothing in this design listens for webhooks |
| Repository permissions | **Contents: Read and write.** Nothing else. Read is for discovering skills, write is for generated paths and companion authoring |
| Account permissions | None |
| Where can this be installed | Only on this account |

Then generate a private key, which downloads a `.pem`, and set the three values above in Vercel deployment configuration. The key is a secret: it is never `VITE_` prefixed, never committed, and never logged.

The user installs it themselves on **one repository they created**, which is why Satchel needs no repository-creation permission. `https://github.com/apps/<slug>/installations/new` is the link the companion shows.

Revoking the App in GitHub settings stops future writes. It does not remove an already installed plugin from any host, and the interface says so.

The publish handler holds no service-role key, exactly as the MCP handler does not. Everything it reads and writes in Satchel goes through the user's own token under row-level security.
