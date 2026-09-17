# Satchel: the product

**Your work, with you.**

Product definition · 8 September 2026 · Direction agreed; mechanisms proposed unless explicitly marked otherwise.

## What Satchel is

Satchel gives you a durable home for the projects, knowledge, and ways of working you want to carry between AI apps. You can work in a supported app on your phone, continue in a coding agent on your laptop, and recover the relevant decisions, preferences, and next steps without rebuilding the background every time.

The intended product combines a hosted service, a companion interface, and integrations delivered through supported AI plugin platforms. The companion lets you inspect and configure what the connected apps can use. The plugins make that information useful where you already work.

You should not need to open Satchel before every conversation. Once a supported integration is set up, the agent should be able to find the relevant project, retrieve current context, and save an explicit update through that integration. The companion is there when you want to add something yourself, correct it, inspect access, or resolve a setup problem.

The initial audience is one person using their own accounts and devices. Sharing a skill package with someone else is distinct from giving that person access to private memory. Multi-user workspaces and collaborative memory are not established V1 requirements.

## Why it exists

JEFF originally centralized task state, repositories, memory, skills, providers, and agent execution. That made a single workspace powerful, but also required maintaining launchers, worktrees, crew coordination, hooks, personas, queues, and machine-specific setup.

The rethink began with a practical challenge: existing AI apps increasingly provide the execution and interface people need. Satchel should earn its complexity by providing continuity between those apps. Its value is the useful information and workflows that remain yours when you change a device, start a fresh chat, or use a different provider.

The design should be judged by reduced repetition and reliable handoffs. Merely moving JEFF's old controls into a web dashboard would not establish that value.

## What “your stuff anywhere” means

| What follows you | Intended result |
|---|---|
| Explicit preferences and decisions | A connected fresh conversation can retrieve the current, relevant version |
| Project context | Different apps can identify the same ongoing effort and its sources |
| Tasks and handoffs | You can discover the next step and the evidence left by the previous session |
| Skills and configuration intent | You can discover your workflows and set them up on supported targets |
| Source and revision information | You can tell where something came from and whether it is current |

“Anywhere” means supported, authenticated surfaces with verified capabilities. It does not promise identical hidden model state, identical responses, automatic synchronization of every native chat, universal mobile plugin support, or execution of laptop scripts from a phone. Unsaved code on a sleeping laptop does not travel because its task has a handoff.

## The core concepts

| Concept | Meaning |
|---|---|
| Project | An ongoing effort with a purpose, context, resources, decisions, and tasks |
| Repository | A source location that can belong to one or more efforts; not the definition of a project |
| Memory | A deliberately saved record with a name, description and on-demand details, with scope and provenance |
| Skill | A reusable procedure, optionally with scripts, references, templates, and dependencies |
| Plugin | An installable package for an AI platform that can expose workflows and a connection to Satchel |
| Installation | A particular plugin or skill version made available in a particular host environment |
| Connection | An authenticated relationship with an app or source, with an explicit access boundary |
| Task | A personal or project-scoped unit of work whose authoritative state lives in Satchel's Supabase database |
| Handoff | A portable account of completed work, decisions, validation, code state, blockers, and next steps |

These concepts must remain distinct in storage and the interface. In particular, a skill appearing in your library does not establish that it is installed or runnable on every device.

## What you should be able to do

### 1. Connect an AI app to your Satchel

Choose the actual app and surface, use its supported plugin or connection setup, sign in to Satchel, and select the access it needs. See whether setup is incomplete, authorized, reachable, or verified through a real operation.

The proposed experience separates your own companion session from agent connections. You can save directly in Satchel on your phone even if Claude has read-only access. Granting Claude write access is a different action.

A switch must reflect an enforced permission or a clearly described setup request. It must not manufacture a successful installation or authentication result.

### 2. Keep a project understandable across apps

Create a project with a recognizable name and a short brief. Link its code repositories, source documents, task destinations, and relevant skills. Add decisions and handoffs as work progresses.

For example, “Release workflow” may involve backend and frontend repositories and several tasks. “Reimbursements” may involve a procedure, monthly tasks, and privately stored receipts without any code repository. Both are projects.

A native Claude or Codex project can refer to the Satchel project. Its chats and local environment remain owned by that app. Automatic synchronization of vendor sidebars is not part of the initial promise. See [Projects](projects.md).

### 3. Save something worth remembering

Write in the companion or explicitly tell a connected agent to remember a statement. Choose or resolve whether it applies to you, a repository, or a project. Receive an acknowledgement only after the shared source accepts it.

Each memory has a name and short description that a supported integration's hook should always include in the authorized context's memory index. The agent reads More info by name and scope when needed, rather than loading every full record up front. The companion and database implement personal (**For me**) and project memory with separate index/detail reads. A project is optional; the same editor serves both destinations. Native hooks and repository scope remain pending. See [the memory contract](memory-and-storage.md).

An example is: “Remember for Satchel: no personas and no curator in the first version.” The record should preserve what was stated, its source, relevant scope, writer, and revision. The agent should not convert brainstorming or its own guesses into confirmed preferences.

There is no curator, proposal inbox, scheduled consolidation, or automatic transcript extraction in the initial product. Task progress can still be recorded as work evidence; it must not be misrepresented as a user-stated personal fact.

### 4. Correct and forget accurately

Correct a particular record. Future retrieval should use the new version, while history explains the change. Concurrent corrections should not silently overwrite each other.

Forget removes a record from active retrieval. The interface must explain the actual retention behavior of the selected storage: Git history, backups, exports, previous chats, and vendor-native memory can retain copies. Satchel must not promise deletion from systems it does not control. See [Memory and storage](memory-and-storage.md).

### 5. Pick up work somewhere else

Open the companion's continuity view or ask a connected agent where a project was left. Retrieve its task and latest handoff. Continue using a reachable branch, commit, PR, artifact, or explicitly transferred patch.

“Resume” can use a native launch route where verified. Otherwise, offer a clearly labeled handoff the user can copy. The handoff is useful even when automatic app launch is unavailable. It is not a transferred live process or a cloned conversation.

### 6. Bring your skills to the tools that can use them

Browse the skills you rely on, understand their source and version, associate them with projects, and see what each target needs. Installation should use existing host mechanisms rather than a new universal package manager.

An instruction-only review procedure may be useful in several apps. A database investigation skill might need a service connection. A reimbursement script needs a runtime and files in its execution environment. A native app automation skill requires that app and its supported controls.

The desired interface answers four questions separately: “Do I have this?”, “Is it installed here?”, “Is it authorized?”, and “Can it run here?” See [Skills and plugins](skills-and-plugins.md).

### 7. Manage portable tasks without requiring a repository

Satchel owns V1 task content, state, revisions, handoffs and event history in Supabase. A task can live in **For me** with no project, or belong to a Satchel project for shared context. Both work for code and non-code work. GitHub issues, pull requests, Notion pages and other HTTPS objects can be attached as typed references; Satchel does not mirror or synchronize their state.

Private task files live in Supabase Storage and use an explicit reserve, upload and verification lifecycle. Agent read, write and upload permissions are separate. A public source-plugin loader, marketplace and synchronization engine remain deferred.

### 8. Understand what is actually available

Inspect the selected app's effective project access, current context, skill readiness, and last verification result. Distinguish a server connectivity check from proof that a fresh conversation retrieved useful context.

A context preview should use the app's effective permissions. A separate manual export can show what you choose to share under your own permissions; its label must make that distinction explicit.

### 9. Take your information with you

Export portable records and configuration without credentials. Preserve identifiers, sources, revisions, and correction history. Keep original documents and live task authorities identifiable.

Satchel being hosted does not mean every external source must be copied into its database. Supabase is the V1 authority for Satchel memory and task records, while linked repositories, documents and other systems remain identifiable external sources rather than synchronized replicas.

## Representative experiences

**Phone to laptop:** discuss a decision in a supported phone chat, explicitly save it, then start a fresh laptop chat about the same project. The plugin retrieves the decision and its source. The user does not have to open a dashboard and paste it again.

**New laptop:** sign in, install the applicable host plugin, choose allowed projects, and verify retrieval. The skill library appears, but local scripts remain “setup required” until their dependencies and credentials are configured on that environment.

**Change your mind:** correct a design decision on the phone. A later laptop retrieval sees the correction as current. An older conversation may still contain the old text; retrieving current context is how the agent finds the change.

**Reimbursement:** prepare a monthly task on the phone and inspect the workflow. Run the script later where the receipts and required runtime exist. Save the result and next step as a handoff. Do not place bank statements into broadly shared memory merely to make the workflow portable.

**Unsupported app:** select an authorized, bounded handoff and copy it manually. The interface explains that this is a snapshot and does not provide automatic future updates or save-back.

## Deliverables and limits

| Intended deliverable | What it must establish |
|---|---|
| Hosted service | Authenticated, durable context operations that work with the home laptop off |
| Responsive web companion | Project, memory, connection, skill, task/handoff, and configuration flows |
| Android experience | Comfortable phone access to the same account; native packaging and share-to-save remain delivery choices |
| Native ecosystem plugins | A small Satchel integration for supported hosts, with tested installation and retrieval behavior |
| Supabase task system | Personal/project tasks, planning relationships, continuity evidence and resources behind the internal service boundary |
| Portable data and setup documentation | Export, recovery, per-platform instructions, capability limits, and version visibility |

There is no new general chat client, model router, provider billing aggregator, persistent persona roster, curator, remote worker fleet, or duplicate task database in the initial scope. Existing apps own conversations, agent execution, worktrees, native scheduling, and model selection. Satchel may link to their outputs and guide setup.

The current repository contains documentation and historical prototypes only. It does not yet contain these implemented deliverables.

## How we will judge the product

Prove the core loop on actual accounts and devices: explicit save, fresh retrieval, correction, and laptop-off access. Check isolation, failed writes, export/recovery, and skill setup on a fresh machine. Observe whether ordinary project requests retrieve useful context without repeated reminders.

Earlier reports proposed a sixty-second acknowledged-save-to-retrieval target and nine successful ordinary retrievals in ten opportunities. These remain proposed pilot targets, not measured guarantees. The important result is less repeated explanation without making the user maintain another complicated system. See [Migration and validation](migration-and-validation.md).
