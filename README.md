# Satchel

**Your work, with you.**

Your projects, knowledge, and ways of working—with you across your AI apps.

Satchel is the next direction for JEFF: a hosted service with companion interfaces and integrations distributed through supported AI apps' plugin platforms.

## Status

The web pilot is live at [satchel-pi.vercel.app](https://satchel-pi.vercel.app). GitHub sign-in, personal memory in **For me**, optional projects, named memory, on-demand details, corrections and deletion work against hosted Supabase. Codex and Claude Code plugins install from the public catalog [NeerajG03/satchel-plugins](https://github.com/NeerajG03/satchel-plugins) and connect to a scoped OAuth MCP service with explicit writes and revocation. See [agent setup and limits](docs/agent-setup.md), [native runtime evidence](docs/checkpoints/native-agent-pilot.md), and the [hosted web checkpoint](docs/checkpoints/hosted-web-pilot.md). The user has confirmed phone sign-in and use. See [development setup](docs/development.md).

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
- Native Codex and Claude Code packages connect to one hosted service. General ChatGPT/Claude mobile chat integration and remote package releases remain unvalidated.
- Start with GitHub Issues as the task source. A Satchel extension system for additional task sources is deferred; consuming existing AI plugin platforms is a separate decision.
- Use explicit memory saves and corrections. Personas and a curator are outside the initial scope.

## Design

The visual direction is a personal notebook with physical controls: warm paper, readable typography, dark framing, and restrained orange accents. The mockup establishes look and feel; its interactions and sample data do not establish the product architecture. Light and dark themes are intended.

## Still to resolve

Project boundaries, storage and sharing, skill packaging and installation per platform, permissions, supported mobile capabilities, and the boundary between hosted and local execution need a consistent specification before implementation.

## Platform references

- [OpenAI: Build plugins](https://learn.chatgpt.com/docs/build-plugins)
- [Claude Code: Create plugins](https://code.claude.com/docs/en/plugins)
