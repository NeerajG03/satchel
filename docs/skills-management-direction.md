# Skills management: direction parked for later

11 September 2026. The user asked to document this discussion and return to it later. This is product direction and unresolved design, not authorization to start implementing skill distribution now. The active discussion returns to the existing memory hooks.

## Intended experience

Satchel is where a user adds, removes, organizes and manages skills across their supported agents. The user connects a skill source, chooses a subset for Claude and a possibly different subset for Codex, and applies that configuration through Satchel. Users should not have to maintain generated plugin manifests or a separate distribution repository themselves.

Source repositories may belong to the user or another accessible publisher. They remain the authoritative sources. The shared Satchel memory integration is separate from a user's private skill selections; personal skills must not be bundled into Satchel's public product package.

The requested serving boundary is the user's configuration for a target connector. Several installations may consume that configuration while reporting different installed versions. Skill selection changes in the web UI do not instantly change a running agent.

## Proposed model, not yet selected implementation

| Object | Purpose |
|---|---|
| Source | Repository/package, skill paths, access and source revisions |
| Configuration | A user's desired selection; potentially separate personal/work or project setups |
| Target | Host adapter, initially Claude Code or Codex |
| Release | Immutable resolved selection, source revisions, package version and checksum |
| Installation | A particular host environment consuming a configuration, with observed version/state |

The existing OAuth connection grants access to memory. It does not identify a physical device or implement this skills configuration/installation model.

Proposed flow: connect sources → select skills and target configuration → resolve exact source versions → produce a versioned delivery artifact → authorize download → apply through the host's supported mechanism → verify installed/loaded state. Rollback selects a previous release. Removal updates only the Satchel-managed selection; deletion of upstream source content is a separate operation.

## Design choices left open

- A generated subset plugin versus references to existing packages or an installation manifest. Personalized delivery is required; repackaging all content into one large plugin is not yet a requirement.
- Authenticated Satchel artifact hosting versus a Git-backed route where required by the host. Do not require an extra user-owned repository unless the integration proves it necessary.
- Native host update/authentication support versus a small local installer/helper. An MCP response by itself is not native skill installation.
- Meaning and evidence of downloaded, installed, loaded, update pending, restart required, and unknown/offline states. Missing a recent report does not prove a device is offline.
- Global and project selection precedence; source name collisions; dependency and tool availability; incompatible runtimes; permissions added by an update.
- Editing semantics: upstream edit, fork, or local override. Adding/removing a configuration reference must not silently edit or delete the source skill.
- Private source access, redistribution permissions, package authentication and device registration. Memory OAuth and artifact-download authorization are separate capabilities, though onboarding may coordinate them.
- A checksum verifies the selected artifact; its trusted release metadata still needs an authenticated source. Download revocation cannot erase an already installed skill.

## Research already established

Vercel documents selecting individual skills from a repository through the skills CLI. Satchel should reuse suitable existing installation mechanisms rather than duplicate them. [Vercel skills](https://vercel.com/docs/agent-resources/skills).

Claude Code documents HTTPS plugin archives, checksum pins, and authenticated downloads using headers or a helper. Where that helper is configured affects approvals and automatic update behavior. These capabilities are a candidate delivery path, not a tested Satchel implementation. [Claude marketplace distribution](https://code.claude.com/docs/en/plugin-marketplaces).

OpenAI documents native plugin/marketplace packaging. Personalized authenticated feeds and installed-state reporting still need a concrete Codex experiment; marketplace support alone does not prove the complete flow. [OpenAI packaging](https://developers.openai.com/plugins/build/plugins).

## Resume point

When this work is resumed, prove one complete loop: connect one repository, select two skills for Claude and one for Codex, deliver privately, remove one through Satchel, and verify each actual installation. Decide the distribution mechanism from that evidence before building a general sync service.

The current memory pilot remains documented in [agent setup](agent-setup.md), [hook behavior](memory-hooks.md), and [runtime evidence](checkpoints/native-agent-pilot.md).
