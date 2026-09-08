# Proposed architecture

8 September 2026. This is a conceptual boundary map, not an implementation plan or selected technology stack.

## Intended shape

```mermaid
flowchart LR
    C[Satchel web / Android companion] --> A[Authenticated Satchel service]
    O[ChatGPT / Codex integration] --> A
    L[Claude Code integration] --> A
    X[Other explicitly supported clients] --> A
    A --> P[Project and skill catalog]
    A --> M[Canonical memory store: decision open]
    A --> T[TaskService]
    T --> G[GitHub Issues]
    P --> S[Authorized source references]
```

This is the user-facing direction expressed as a proposed architecture: one shared service, companion interfaces, and host-native integration packages. It does not require that every box be a separately deployed service. Start with a small deployable system and use existing infrastructure where it meets the needed behavior.

## Responsibilities

| Component | Owns | Does not imply |
|---|---|---|
| Hosted service | Identity, access checks, record operations, context assembly, catalog access, task adapter | A remote worker fleet or universal execution sandbox |
| Companion | Direct user interaction, configuration, inspection, correction, setup guidance, verification results | Control over every app's internal settings |
| Native integration package | Host-specific discovery, workflow instructions, service connection configuration | All private skills installed or supported on every device |
| Backing memory store | Canonical revisions and deletion/correction semantics | Independent copies in every native memory database |
| GitHub | Authoritative V1 task records | One repository per Satchel project |
| Existing skill sources | Versioned reusable workflows | Satchel ownership of every third-party package |
| Native AI apps | Conversations, model selection, execution, workspace/session lifecycle | Guaranteed equivalent capabilities across their surfaces |

## Proposed request path

A connected host identifies its authorized session and the requested project. The service resolves the project, checks effective access, retrieves current records and permitted source context, and returns a bounded result with IDs, provenance, and revisions. Live task operations go through the GitHub backend.

Writes need permission checks, idempotency, revision checks, and honest acknowledgement. Search indexes must be permission-aware and invalidated on relevant changes. Exact API schemas, tool names, search technology, and storage transaction mechanisms remain open.

The user's companion session is a separate caller from an agent connection. Do not tie the companion's ability to save to Claude's permission. The host remains responsible for its own tool approvals and execution policy; Satchel enforces its service-side access independently.

## Why a hosted service

The intended context loop should keep working when the home laptop is off. A laptop behind a tunnel can demonstrate a development connection but does not satisfy that product property. Deployment provider, region, operational cost, backup policy, and whether to offer self-hosting are unresolved.

Hosting and Git-backed storage can coexist: a hosted service could mediate authorized Git operations. A hosted database could also meet the logical record model. Choose based on write/correction semantics, access boundaries, retrieval, portability, retention, and actual phone behavior; do not choose solely because a mockup displays a commit hash.

## Reuse and limits

Use the platforms' own plugin distribution and authentication support. Do not implement a universal plugin installer or silently edit hidden native chat/memory stores. A host-native configuration/export path may be appropriate where verified.

Keep original documents in their source systems where possible. Linking a source is different from implementing its connector. GitHub is the only built-in task source for V1; no Notion adapter is implied by an archived document or an independently installed skill.

A catalog and context service should stay useful without a large dashboard, automatic transcript collection, model routing, session orchestration, or background curation. Any later remote execution needs its own specification and evidence of need.

## Important unresolved implementation questions

1. Canonical memory and project storage, history, and export format.
2. Authentication, account linking, work/personal partitioning, and credential ownership.
3. Exact supported clients, account tiers/policies, and mobile setup paths.
4. Private skill distribution and evidence of installed/ready state.
5. Native versus responsive-web Android delivery and share-to-save behavior.
6. Context selection and refresh without assuming automatic retrieval.
7. GitHub metadata mapping, limits, concurrency, and failure recovery.
8. Deep links and handoff behavior that each destination actually supports.

These questions are not resolved by the current artifact. Use the [validation scenarios](migration-and-validation.md) to make the architecture concrete before declaring it ready to build at full scope.
