# Projects

Proposed domain model · 8 September 2026. The user explicitly identified the old project model as insufficiently resolved; this document provides a revised model for review.

## A project is the effort, not its storage container

A project is an ongoing effort with an outcome, current context, resources, and work to do. It can have zero, one, or several code repositories. A repository can support more than one project. A native AI app's project is a convenient host-specific view, not the portable identity itself.

Examples:

| Project | Resources | Reusable skills | Tasks |
|---|---|---|---|
| Satchel | Product docs, design files, eventual code repositories | Review, writing tests, interface design | GitHub implementation issues |
| Release workflow | Backend and frontend repositories, release guidance | Release procedure | GitHub tasks created for Satchel-managed work |
| Reimbursements | Rules, templates, restricted receipts and statements | Reimbursement workflow | Monthly claim issues with appropriately limited evidence |
| Interview preparation | Restricted notes and selected reference material | Relevant preparation procedure | Optional task links; no required code repository |

These are examples, not imported projects. Existing team tickets in other systems remain externally owned and unsupported by V1 task operations.

## Proposed project record

Keep a stable ID, display name and aliases, brief, lifecycle state, audience/access partition, source references, task destinations, skill references, important decision references, and revision metadata. Store large artifacts elsewhere and link them.

The brief should answer: what are we doing, why, what is in scope, what is decided, what is open, and where does the evidence live? It should remain readable without a particular AI app.

Repository references identify the remote and any relevant role. Local clone paths belong to a device/environment mapping. A path on one Mac cannot be the project's global identity.

Task destinations specify the GitHub repository where a new issue should be created. A project with no code can use an explicitly chosen private task repository; it does not require an otherwise empty repository per project. If there are several destinations, ask only when routing is genuinely ambiguous. No repository should be created implicitly just because the user adds a project.

## Lifecycle

1. Create the brief and stable identity.
2. Link resources and choose the task destination where needed.
3. Set the access boundary and grant selected app connections access.
4. Associate relevant skills without automatically installing them everywhere.
5. Retrieve the brief, current decisions, relevant repo context, and live tasks during work.
6. Update the authoritative source or explicitly record a project decision.
7. Archive completed projects while preserving useful history and links.

## Relationship to native app projects

An app project may point to the Satchel ID and brief through supported instructions or the plugin. App chats, local workspace setup, and native memory remain app-owned. Satchel should not maintain independently editable copies of the same brief in every app.

If a host requires an uploaded snapshot, record its source revision and label its refresh behavior. A plugin installation does not establish that all native projects were created, associated, or refreshed.

Name resolution can use aliases and known repository associations. If two accessible projects have the same name, disambiguate before saving a decision. Renaming a project should not orphan memories or tasks that reference its stable ID.

## Access and sharing

Semantic scope and authorization are separate. A project label does not protect work material from a personal integration. Check access to the project and to each referenced resource before returning content. A link can exist without granting permission to fetch or copy its target.

Initial sharing is across the owner's supported accounts and devices. Team roles, invitations, shared project editing, and organization administration require a later explicit scope decision. Skill-package sharing can proceed independently of those features.

## What is superseded or open

The September 6 handoff's “each project is its own private repo” rule is not adopted as Satchel's definition. Neither is a flat `projects.yaml` file mandated as the production database; it remains a possible portable representation.

Open choices include the physical home for project briefs, source refresh behavior, archive/search defaults, local-environment mappings, and a precise schema. The implementation must also prove how repository context is included for a multi-repo project; the mockup currently omits that relationship from its context assembly.
