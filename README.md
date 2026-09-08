# Satchel

**Your work, with you.**

Your projects, knowledge, and ways of working—with you across your AI apps.

Satchel is the next direction for JEFF: a hosted service with companion interfaces and integrations distributed through supported AI apps' plugin platforms.

## Status

Early product definition and design. This repository is private while the product model and implementation are developed. No service or plugin is implemented yet.

## Start here

- [Product definition](docs/product.md): what Satchel should do and how the main experiences should work.
- [Build roadmap](docs/build-roadmap.md): system and user decisions, proposed stack and deployment, and staged deliverables.
- [Documentation index](docs/README.md): projects, skills and installation, memory, tasks, architecture, decisions, migration, and discussion history.
- [Design](design/README.md): the current visual direction, original interactive prototype, review notes, and earlier explorations.

Current docs distinguish agreed direction from proposed mechanisms and open choices. Historical reports and mockups are preserved unchanged; their older assumptions do not override the current product definition.

## Direction

- Keep useful context available across supported apps and devices, with explicit control over what is saved and shared.
- Treat projects as ongoing efforts with context, resources, and tasks; repositories are resources a project can reference.
- Treat skills as reusable instructions and, where needed, scripts and dependencies. Library membership, installation, authorization, and execution readiness are distinct.
- Explore plugin packages for ChatGPT/Codex and Claude Code connected to one hosted service. Platform support and installation mechanisms still need validation.
- Start with GitHub Issues as the task source. A Satchel extension system for additional task sources is deferred; consuming existing AI plugin platforms is a separate decision.
- Use explicit memory saves and corrections. Personas and a curator are outside the initial scope.

## Design

The visual direction is a personal notebook with physical controls: warm paper, readable typography, dark framing, and restrained orange accents. The mockup establishes look and feel; its interactions and sample data do not establish the product architecture. Light and dark themes are intended.

## Still to resolve

Project boundaries, storage and sharing, skill packaging and installation per platform, permissions, supported mobile capabilities, and the boundary between hosted and local execution need a consistent specification before implementation.

## Platform references

- [OpenAI: Build plugins](https://learn.chatgpt.com/docs/build-plugins)
- [Claude Code: Create plugins](https://code.claude.com/docs/en/plugins)
