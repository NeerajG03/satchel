# Skills, plugins, and installation

Original product proposals: 8 September 2026. Update, 11 September: the shared memory integration is now installed and tested in the native clients; see [agent setup](agent-setup.md). Personalized skill selection and delivery remain unimplemented. The user asked to [park the skills-management direction](skills-management-direction.md) and return to it later. Historical future-tense installation passages below are superseded by those current implementation documents.

## Four different objects

**Skill:** reusable instructions plus any supporting scripts, references, templates, or assets.

**Library entry:** Satchel's reference to a skill's source, version, purpose, dependencies, audience, and compatible environments. A library entry can point to an existing package; Satchel need not copy and republish it.

**Plugin package:** the host-native distribution unit that can carry skills and a Satchel service connection. One product can need different packaging for different ecosystems.

**Installation:** a particular package/version activated in a particular app and execution environment, with its host installation scope. Installation does not by itself authenticate external services or install every system dependency.

This replaces the old assumption that “the skill is in a GitHub repo” or “run `npx skills`” completely describes cross-platform setup.

## Two meanings of plugin

| Meaning | Satchel direction |
|---|---|
| A Satchel plugin installed in ChatGPT/Codex or Claude Code | Part of the intended distribution approach |
| A third-party extension installed into Satchel to sync Notion or another task source | Deferred; no Satchel plugin runtime, marketplace, or source-sync UI in V1 |

Using a native marketplace manifest to distribute our own integration does not mean building a marketplace product. Existing independently installed plugins can supply tools used by a skill; their presence does not make those services built-in Satchel task sources.

## What should live where

Keep reusable skill content versioned at its authoritative source. Satchel's hosted catalog can describe the source, chosen revision, associated projects, and installation instructions. Preserve existing package ownership and licenses when referencing or redistributing content.

A small Satchel integration package should teach the agent how to resolve a project, retrieve context, save explicit records, correct records, and leave a handoff. These are workflow capabilities; the exact number of skills and tool names remains open.

Do not bundle every personal or work skill into a public integration package. A broadly distributable Satchel connector and private user skill collections have different audiences. The product source repository is also distinct from a user's private memory and configuration store.

Whether private skills are referenced through existing marketplaces, packaged into selected collections, or exported for host installation remains open. Fetching instructions from the hosted catalog is useful, but must not be labeled native installation.

## Capability classes

| Class | Example | Requirement | Phone expectation |
|---|---|---|---|
| Instructions only | Review style or investigation procedure | Host can load and follow the instructions | Potentially usable on supported hosts; verify loading |
| Connected service | Release workflow using GitHub and Slack | Required tools and accounts authorized in the executing host | Depends on that mobile surface's actual tools |
| Script | Trace analysis or reimbursement processing | Compatible runtime, declared dependencies, files, credentials, network | Inspect or prepare; no automatic laptop execution |
| Local application control | Editor configuration or desktop app automation | Compatible device, application, and control interface | Generally hand off to the supported environment |

A hosted service for context is not a general hosted skill runner. Promoting a local script into a remote tool would add execution, secrets, isolation, and lifecycle requirements and needs a separate decision.

## Platform packaging and setup

### ChatGPT and Codex

OpenAI documents a shared public plugin directory, while capabilities and private/local marketplace availability can vary by surface. Its package format uses `.codex-plugin/plugin.json`, with skills and appropriate MCP connection configuration. A single listing is therefore not evidence that all included capabilities run on every surface. [Architecture](https://developers.openai.com/plugins/concepts/plugins), [Packaging](https://developers.openai.com/plugins/build/plugins).

For Satchel development, build the service connection, test its tools, package the integration, and test the installed experience. OpenAI documents developer-mode MCP testing and notes that availability depends on account/workspace policy. A reachable endpoint and successful tool test are necessary but do not prove a fresh model session will retrieve the right context. [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt).

Proposed user flow: discover/install through the supported host route, connect the Satchel account, grant selected access, activate the package where required, and run a cross-client verification. Document the exact steps for each tested app version and account type before claiming support. There is no published Satchel listing or ready installation command today.

### Claude Code

Claude Code plugins can package skills and MCP servers, along with other optional components. Its plugin manifest lives under `.claude-plugin/`; skills and MCP configuration live at the plugin root. Satchel should use only the components its workflows need. [Create plugins](https://code.claude.com/docs/en/plugins).

Claude Code documents marketplace installation with `/plugin install plugin-name@marketplace-name` and user, project, and local scopes. Project scope refers to repository configuration in that host; it does not define a Satchel project or automatically provision collaborators' credentials. Shared configuration can still require individual installation. [Install plugins](https://code.claude.com/docs/en/discover-plugins).

Proposed Satchel flow: add the approved distribution source, install the selected version and scope, authenticate to Satchel, activate according to the host's response, then verify an actual project retrieval and authorized save. The identifiers above are generic documentation syntax, not a Satchel command to execute now.

### Claude chat, web, and mobile

Claude Code documentation does not establish a universal installation path in every Claude chat surface. Verify the real account's remote connection/plugin capabilities separately. Do not copy terminal installation instructions into the Android guide.

A supported hosted connection may provide retrieval and writes without local scripts. If a surface cannot load a native skill, a tool response or a user-provided handoff is a distinct fallback. It must be labeled and tested as such.

### Satchel web and Android companion

These are first-party interfaces to the user's Satchel account. They should not require the user to grant Claude or Codex write access before saving directly. Their sign-in, project selection, and permissions are independent of an AI app's installation.

A responsive web experience is the proposed first implementation. An installable web app and a native Android app are different deliverables. Native share-to-save, device lifecycle behavior, and distribution are open packaging decisions.

## Installation state must be evidence-based

Track the host/surface, account reference, execution environment, host installation scope, source revision, configured permissions, and last verification evidence where the host exposes them. Do not store credentials in that record.

Display separate states: in library; compatible; setup required; installed or installation unverified; connected; dependencies missing; ready for a specific operation; verification failed or expired. A user reporting an installation is different from a host-confirmed result.

“Ready” must say ready where and for what. A script verified on one Mac remains unverified on a second machine. Installation on an account may carry across some vendor surfaces; environment dependencies and runtime capabilities still need separate checks.

## Updates, sharing, and removal

Keep source identity and version visible. Use existing host update mechanisms where possible. New permissions or dependencies need an explicit setup step; changing a catalog row must not silently expand access. Uninstalling a plugin removes that installation, while revoking Satchel access stops future authenticated access through the relevant grant. Previously delivered chat text is unaffected.

Sharing a package shares its included content. It does not share private project records, credentials, or the owner's service authorization. Each recipient connects their own authorized account. Private skills must stay within their intended audience.

## JEFF portability work still required

The earlier audit found dependence on the root Python environment, a machine-specific path in the Langfuse setup, and root `.env` configuration. Treat these as historical audit findings to recheck before migration. Declare dependencies per workflow or a shared versioned package; replace hardcoded paths with configuration; keep credentials per environment; preserve useful `api` and `lyric-cli` tools independently.

Remove obsolete persona and gig dispatch assumptions from migrated workflows. Verify a representative script from a fresh clone on a second machine. No bulk skill installation, registry deletion, or republishing is performed by this documentation update.
