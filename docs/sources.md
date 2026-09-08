# Sources and provenance

Collected 8 September 2026.

## Conversation and local material

The current product documents synthesize the available conversation and these preserved sources:

- [Original portable-context report](archive/jeff-rethinking/JEFF-portable-context-report.md): capability inventory, migration mapping, memory semantics, skill classes, and acceptance proposals.
- [Original companion product brief](archive/jeff-rethinking/JEFF-v2-product-design.md): web/Android scope, screen flows, and configuration focus.
- [Task backend and deferred plugin sketch](archive/jeff-rethinking/JEFF-v2-task-source-plugins.md): GitHub-only V1 and later source-extension ideas.
- [Rejected Codex visual study](archive/jeff-rethinking/JEFF-v1-visual-direction.md).
- [Claude handoff decisions](archive/jeff-handoff/DECISIONS.md) and [handoff README](archive/jeff-handoff/README.md): notebook direction, prototype behavior, and earlier Git-backed architectural assumptions.
- [Alternative HTML porting map](archive/jeff-handoff/reports/jeff-porting-map.html).
- [User-supplied comparison review](archive/conversation-attachments/comparison-review.txt).
- [User-supplied section-by-section revision](archive/conversation-attachments/section-by-section-revision.txt).
- [Current visual artifact sources](../design/prototype/) and [earlier Codex mockups](../design/archive/early-codex-mockups/).

The handoff's separate report snapshots are retained too, even where they duplicate the original reports. The [source manifest](source-manifest.json) lists every imported file, original local location, repository destination, and SHA-256 hash. Copies are byte-for-byte originals. An archived report may link to an old machine path or contain conclusions later rejected; use this index and [decisions](decisions.md) for current navigation and interpretation.

The inventory in old reports was not re-audited against the live JEFF system during this collection. Claims that earlier browser tests passed are historical claims by those documents. The latest review inspected rendered screens and interaction code; it did not establish backend or native-client compatibility.

## Official platform documentation

Reviewed 8 September 2026. These establish host mechanisms, not a guarantee that Satchel has implemented or tested them on the user's account.

| Source | Use in this collection |
|---|---|
| [OpenAI: Build plugins](https://learn.chatgpt.com/docs/build-plugins#continue-with-the-builder-documentation) | User-supplied starting point for native ecosystem distribution |
| [OpenAI: Plugin architecture](https://developers.openai.com/plugins/concepts/plugins) | Distinguishing skills, server tools, and surface-specific capabilities |
| [OpenAI: Package your plugin](https://developers.openai.com/plugins/build/plugins) | Native manifest and connection packaging; private distribution caveats |
| [OpenAI: Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt) | Server tests versus complete installed-plugin tests and account-policy limits |
| [Claude Code: Create plugins](https://code.claude.com/docs/en/plugins) | User-supplied source for native package structure |
| [Claude Code: Discover and install](https://code.claude.com/docs/en/discover-plugins) | Installation scopes, activation, and per-user setup requirements |

Exact setup guides must be refreshed and tested when packages are implemented. No credentials were connected and no native plugin was installed during this documentation task.

## Design reference trail

Earlier research considered [Linear's design refresh](https://linear.app/now/behind-the-latest-design-refresh), [Raycast settings](https://manual.raycast.com/settings), [Things](https://culturedcode.com/things/features/), [Flighty](https://flighty.com/), and [Craft styling](https://support.craft.do/en/write-and-edit/styling/quick-guide). This list preserves the research trail; it does not assert a completed visual comparison or user approval of those directions.

The Claude handoff named Claude's warmth, Arc's confidence, and unobtrusive physical objects as influences. The actual local notebook/hardware artifact is the current visual reference.

## Coverage limits

This collection contains the available saved reports, two supplied comparison texts, current and earlier design sources, prototype scripts, screenshots, and a synthesis of the accessible discussion. It is not a complete raw conversation export. It does not include JEFF's actual memory database, task database, transcripts, receipts, secrets, or skill runtime files. Collecting the discussion does not require copying those operational datasets.
