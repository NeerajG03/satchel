# Skills delivery: requirements

15 September 2026. This resumes the [parked skills-management direction](skills-management-direction.md) at the user's explicit request. That document's own resume point is the acceptance test here: connect a source, select skills for Claude and Codex, deliver privately, remove one through Satchel, and verify each actual installation.

Labels follow the [documentation conventions](README.md#how-to-interpret-the-documents). **Agreed** records an explicit user decision in this session. **Proposed** is a mechanism chosen to serve it. **Open** is unresolved.

## 1. Host capability evidence

This section is evidence, not proposal. It was gathered from current vendor documentation before any design choice was made, because the available mechanism constrains the product.

| Delivery mechanism | Claude Code | Codex / ChatGPT desktop |
|---|---|---|
| Git repository (`owner/repo`, HTTPS or SSH Git URL) | yes | **yes** |
| Git subdirectory, pinned by `ref` or `sha` | yes | **yes** |
| HTTPS zip archive with `sha256` | yes | no |
| Plain HTTPS URL serving marketplace JSON | yes | no |
| Authentication headers on the feed | yes | no |
| npm package | yes | yes |
| Local directory | yes | yes |

A Git repository is the only mechanism both hosts read natively. This is the finding that selects the delivery design, and it supersedes an earlier working assumption in this session that an authenticated HTTPS archive feed could serve both.

Two further findings reduce the work:

- Codex reads `$REPO_ROOT/.claude-plugin/marketplace.json` as a legacy-compatible marketplace, and OpenAI states it accepts Claude-compatible plugin manifests. One repository can therefore serve both hosts.
- Claude Code states it uses the user's existing git credential helpers for marketplace and plugin operations, so a private repository needs no new credential on the user's machine. Codex accepts HTTPS and SSH Git URLs; it does not document credential behavior, so private-source access on Codex is **open** until tested.

### 1.1 Surface coverage

| Surface | Install route | Status |
|---|---|---|
| Claude Code CLI, local | `claude plugin marketplace add <owner>/<repo>` | documented |
| Claude Code desktop app | same | documented |
| Codex CLI, local | `codex plugin marketplace add <owner>/<repo>` | documented |
| Codex in ChatGPT desktop app | repo and personal marketplaces | documented |
| Claude Code cloud and web | `/plugin` is not available in cloud sessions | **blocked directly**, one candidate route in section 6 |
| Codex cloud | no documented mechanism for plugins or skills | **not possible today** |
| Claude and ChatGPT mobile chat | no install path we control | not a target |

Claude Code documents that cloud sessions are configured through environment variables or settings files committed to the repository, not through `/plugin`. That leaves one candidate route, narrowed in section 6.

Codex cloud is a firmer no than expected. OpenAI enumerates plugin surfaces four separate times and cloud is never among them: "Plugins work in Chat and Work across ChatGPT on the web, desktop, and mobile, and in Codex in the ChatGPT desktop app. Codex CLI also has a plugin browser for Codex environments." Standalone skills are documented for "the ChatGPT desktop app, Codex CLI, and IDE extension". The cloud task lifecycle names only `AGENTS.md` as repository customization, and the referenced `openai/codex-universal` image does not list a `codex` binary, so a setup script has nothing to run. This is silence plus positive lists that exclude cloud, which is not a documented no, but it is not something to build on either.

## 2. Agreed decisions

| ID | Decision |
|---|---|
| S01 | Satchel manages the user's skills and delivers a personalized selection to each supported agent. The user does not hand-maintain plugin manifests or a distribution repository. |
| S02 | Delivery uses one private Git repository per user, written by Satchel. Section 1 is the evidence that this is necessary, which satisfies the parked document's condition against requiring an extra user-owned repository. |
| S03 | The delivery repository belongs to the user's own GitHub account. Satchel writes to it through a Satchel GitHub App the user installs on that one repository, with Contents read and write. This is separate from Supabase GitHub sign-in and revocable in GitHub's own settings. |
| S04 | **Satchel never stores skill content.** A skill's only home is a Git repository. Satchel stores sources, selection and releases. This makes "Satchel is the serving mechanism" literally true, and it is a deliberate reversal of an earlier decision in this session to let Satchel author and store skills. |
| S05 | One repository serves as both the user's skill source and the delivery target. `skills/<name>/SKILL.md` at its root is the single source of truth. Per-target plugin directories are generated from it. Satchel records the paths it generated in each release and only ever writes or deletes those, so the source directory is never touched by a publish. |
| S09 | Generated per-target directories contain real copies, not symlinks. Measured: three identical `SKILL.md` files resolve to one Git blob, so copying costs nothing, while symlinks lose `claude plugin validate` coverage (the validator states it reads components without following symlinks), dangle under Codex's plugin cache copy, and break the archive route. |
| S10 | Authoring from the companion means Satchel commits to the user's skills repository on their behalf. The web and phone capture path is preserved without Satchel becoming a second home. |
| S11 | Agents get no access to the shelf: no new MCP tools and no new grants. This is not a gap, because a skill is a file in a repository the agent already works in, so updating one is an ordinary edit followed by a commit. Publishing stays companion-only, so nothing an agent edits reaches another agent until the user publishes. |
| S06 | Kits are flat per target. Projects may tag a skill for the user's own organization; tags do not affect delivery. |
| S07 | The skills kit is a separate plugin from the existing `satchel` memory plugin. Private skills are never bundled into the shared product package. |
| S08 | Targets are Claude Code and Codex, both native, from one repository. |

## 3. Object model

| Object | Holds | Notes |
|---|---|---|
| Source | Provider, repository, resolved commit sha, last sync | One source is the user's own skills repository, which is also the delivery target. Others are any readable repository |
| Skill | Identity only: source, path, name, description, and the sha they were read at | A cache for display and selection. The content lives in the repository, never here |
| Kit | One per target, holding the user's current selection | Flat; no project scoping |
| Release | Resolved selection, frozen file contents, source shas, version, checksum, and the list of generated paths | Frozen contents make a release survive an upstream source disappearing. The generated-path list is what makes a publish safe in a shared repository |
| Delivery | The repository, the App installation, and the branch | No fetch record, because a fetch is not observable. See R15 |

Content is read from the source at publish time and frozen into the release. A release therefore records what was delivered and which commit it came from, while the shelf holds only enough to browse and choose.

## 4. Functional requirements

### Shelf and kits

- R01 The user can connect a source repository, and Satchel discovers the skills in it by reading `skills/<name>/SKILL.md`, recording each name, description and the commit it was read at.
- R01a The user can write a skill from the companion, including on a phone, and Satchel commits it to their own skills repository as `skills/<name>/SKILL.md`. Satchel does not keep a second copy. A failed commit is reported as a failure, never as a saved skill.
- R01b Editing a skill anywhere other than the companion is expected and supported: the user or their agent edits the file in the repository and commits. Satchel detects the new commit on the next sync and shows the skill as changed since the published release.
- R02 The user can tag a skill with projects. Tags are organizational and must not change what is delivered.
- R03 The user can tick and untick skills per kit. An unpublished change is visible as such, and the currently published release stays in effect until the user publishes.
- R04 Publishing produces a new release with a version, a checksum, the frozen contents, and the source revision of every included skill.
- R05 Removing a skill from a kit and publishing removes it from the agent on its next update. Satchel must state explicitly that the source skill was not edited or deleted.
- R06 The user can see a release's history and publish a previous release again as a new version.

### Delivery

- R07 Satchel adopts one private GitHub repository the user created, and writes both `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`, each in its host's idiomatic shape, plus one plugin directory per kit.
- R07a A publish writes and deletes **only** paths Satchel generated, taken from the previous release's recorded path list. `skills/` and anything else the user keeps in that repository is never written, never deleted, and never used as a base for the generated tree. This is the single most expensive thing to get wrong in this design, so it gets its own test.
- R08 Each publish is a commit and a tag. Plugin `version` is bumped on every release, because Claude Code only delivers updates when that field changes.
- R09 The delivery repository states in its README that it is generated and that hand edits are overwritten on the next publish.
- R10 Satchel shows the exact one-time setup commands per host, and the exact update command per host.
- R11 Setup guidance must cover Claude Code's documented limitation that a background marketplace refresh disables git credential helpers, so a private HTTPS remote cannot auto-refresh. The documented remedies are an SSH remote or `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1`. Manual update authenticates normally.
- R11a The generated kit must never declare an MCP server, in `mcp.json`, `.mcp.json`, an inline declaration, or `.app.json`. OpenAI marks any plugin declaring MCP servers as **Desktop only**, including servers reached over remote HTTPS, and a Desktop-only plugin is discoverable but not usable on web or mobile. Keeping the kit free of MCP is therefore not only hygiene, it is what stops the kit inheriting that restriction. This is the mechanical reason behind S07, beyond audience separation: bundling skills into the existing memory package, which does declare `.mcp.json`, would have made every skill Desktop only.
- R12 Every release also produces a zip of the same tree with a recorded sha256. This costs almost nothing over the commit and is the input to every cloud route in section 6 as well as Claude Code's archive source and `--plugin-url`.

### Honest state

- R13 Satchel answers four questions separately and never merges them: is it on the shelf, is it in a published kit, was it fetched, and can it run there.
- R14 Delivery state is per surface, because cloud and local genuinely differ. A single "installed" claim is not permitted.
- R15 Satchel must not claim an agent fetched, loaded, or can run a skill. Because GitHub serves the clone, a fetch is not observable by Satchel at all, so the interface reports the published release and its commit, and states plainly that it cannot see what any agent did with it. Reporting nothing is correct here; inferring delivery from a publish is not.
- R16 A skill carrying scripts or requiring tools is marked as needing setup in the environment where it runs. Delivery is never presented as execution readiness.
- R17 Revoking the GitHub App stops future writes. It does not remove an already installed plugin, and the interface must say so.

## 5. Acceptance test

One loop, on real accounts, as the parked document specified:

1. Create two skills, one written from the companion and one committed straight to the repository by hand, to exercise both paths. Put both in the Claude Code kit and one in the Codex kit.
2. Publish. Confirm the commit, tag, both marketplace files, and the zip checksum.
3. Install in local Claude Code. Confirm both skills are invocable under the plugin namespace.
4. Install in local Codex. Confirm the one skill appears, and record specifically whether Codex authenticated to the private repository without extra configuration, since that is undocumented.
5. Untick one skill, publish, update both hosts. Confirm it is gone from Claude Code and that the Satchel source record is unchanged.
6. Edit one skill's file directly in the repository, sync, publish, and update. Confirm the change reaches the agent and that `skills/` was untouched by the publish.
7. Record what was actually observed per surface, including anything that failed.

A passing loop covers local surfaces only. It is not evidence for any cloud surface.

## 6. Open

- **Claude Code cloud delivery.** Research on 15 September narrowed this considerably. Now documented: a committed `.claude/settings.json` is read in cloud sessions because it is part of the clone, and `extraKnownMarketplaces` is explicitly one of the keys that applies there once the folder is trusted; `github.com`, `api.github.com`, `codeload.github.com` and `raw.githubusercontent.com` are all in the default allowed domains for Trusted network access; and project-scope `.claude/skills/` loads in cloud while personal `~/.claude/skills` does not. Now documented as unavailable: `--plugin-dir` and `--plugin-url` are sideload flags that cloud sessions drop. Still unresolved, and the one thing that decides this route: whether the cloud sandbox can clone a **second** private repository that is not the session's own, given that git credentials stay outside the sandbox behind a proxy with scoped credentials, and whether `enabledPlugins` in project settings installs a plugin or only enables an already-installed one. Both need a real cloud session to answer.
- **Claude Code cloud, admin route.** Distributing through claude.ai **Organization settings > Plugins** removes the credential problem outright, because organization sync reads the marketplace repository through the organization's own GitHub connection rather than the user's. It is Team or Enterprise, admin-only, and organization-wide, which makes it the wrong shape for private personal skills. Recorded because it exists, not because it is wanted.
- **Codex cloud.** Researched and closed as not possible today by any documented mechanism, per section 1.1. Reopening it needs an answer from OpenAI rather than more documentation reading. Recorded alternatives, none the right shape: a repo-scoped `$REPO_ROOT/.agents/skills` directory, which is per repository rather than per user; a workspace marketplace import, which supports private repositories and daily sync but is admin-only and role-scoped; and cloud-managed `config.toml` defining a Git marketplace, which despite the name delivers to local clients only.
- **Private repo sources on Codex.** Credential behavior is undocumented. The four marketplace config keys are `source_type`, `source`, `ref` and `sparse_paths`, none of them an auth key, and no credential helper, SSH key or token handling is documented for marketplace fetching anywhere in OpenAI's corpus. It very likely falls through to whatever `git` does on the machine, which is what we want, but that must be tested rather than assumed. This is now a named step in the acceptance test.
- **Whether a plugin installed from a local personal marketplace is visible on ChatGPT web and mobile.** OpenAI states that skills bundled in plugins are available in Chat and Work across web, desktop and mobile, but it also states that local marketplace plugins install into a local cache directory. Those two statements are about different install routes, so the reach of a locally installed personal-marketplace kit on web and mobile is not established. R11a is worth keeping regardless, because it removes one documented blocker either way.
- **Repo sources generally.** Skill-folder discovery, support-file copying, sha pinning, and what Satchel should do when an upstream source moves.
- **Whether Satchel should ever write into a user's project repository.** Treated as out of scope until explicitly decided, because it changes who can see a private skill.
- **Name collisions** between a Satchel source and a repo source, and between kits.
- **Release retention.** How many releases to keep, and whether the delivery repository is squashed.
- **Installation evidence.** Whether the generated kit should carry an opt-in lifecycle hook that reports its installed release version back to Satchel. That is the only way to turn R13’s fourth question into real evidence, and the memory package already POSTs to an unauthenticated staging endpoint, so the pattern exists. It is off the table for the first cut because a personal skills package phoning home needs its own decision.

## 6.1 Administrator policy

Checked on the pilot machine on 15 September. No `managed-settings.json` for Claude Code and no `/etc/codex/requirements.toml`, so neither host is currently restricting plugin sources locally. Server-managed settings arrive from the claude.ai console rather than the filesystem, so they cannot be ruled out this way.

Stronger evidence: this machine already uses a **private** GitHub repository as a working Claude Code marketplace, authenticated with the user's own git credentials. The mechanism this design depends on is therefore already in use here, not merely documented. Codex's `config.toml` likewise tracks `source_type = "git"` marketplaces, though both of its examples are public repositories, so private-source authentication on Codex stays unproven.

Policies that could block the local route if an administrator ever sets them:

| Host | Key | Effect |
|---|---|---|
| Claude Code | `strictKnownMarketplaces` | Allowlist, checked before any network or filesystem operation, and not overridable by user or project configuration. The delivery repository would have to be added to it |
| Claude Code | `blockedMarketplaces` | Denylist, supports an owner wildcard |
| Codex | `requirements.toml` | Can constrain which plugin marketplace sources users may use, delivered locally or as cloud-managed requirements tied to the workspace |

`disableSideloadFlags` and `disableCommandPluginSources` do not affect this design, which uses neither sideload flags nor command sources. Codex's `features.plugin_sharing` governs publishing a plugin to a workspace, which this design also does not do.

The existing workspace blocker recorded in [agent setup](agent-setup.md), where the Satchel MCP connector shows as Not added with Connect disabled, does **not** apply here. The skills kit carries no MCP server, so it needs no connector. The right sequence is to try the local install first and only escalate to an administrator if a server-managed policy actually refuses it, with the ask being a single allowlist entry. See [admin setup request](admin-setup-request.md).

## 7. Not in scope

No skill execution on the Satchel server. No writes to a source repository the user does not own, and no writes outside generated paths in the one repository Satchel does write to. No marketplace of other people's skills. No sync engine that changes a running agent. No claim of support for mobile chat surfaces.
