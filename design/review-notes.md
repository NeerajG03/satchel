# Review of the notebook and hardware prototype

Review captured 8 September 2026. Based on the local assembled artifact, rendered screens, artboard source, and handoff decisions. No design source was changed during review or documentation collection.

## What works

- Paper and controls have distinct jobs: written context feels personal; permissions and connection indicators feel operational.
- Content typography, interface labels, and provenance readouts establish a useful hierarchy.
- “Where you left off” presents the continuity benefit through actual next steps.
- Skills show purpose and runtime needs rather than only package names.
- The combined phone/laptop presentation makes the desired shared state easy to understand.

The recommendation was to preserve this direction and refine it. The user clarified that it was a look-and-feel overhaul and that incomplete functionality should be resolved in product documentation before further design work.

## Findings to address later

| Finding | Consequence | Intended treatment |
|---|---|---|
| Phone saves are gated by `apps.claude.save` | Direct Satchel use is confused with Claude's permission | Separate companion session access from agent grants |
| Dark frame surrounds a light reading surface | Earlier light/dark requirement is incomplete | Design a true dark content theme |
| Vertical labels and clickable spans/divs | Scanning and keyboard operation need work | Test navigation and use accessible controls in implementation |
| Every project is a scope chip | Large project lists crowd the save flow, especially on phone | Design a selector that handles real collection sizes |
| Old corrections stay visibly struck through | Repeated history can overwhelm current content | Decide when history is shown versus disclosed on demand |
| Blocked-app preview still offers a populated handoff | Automatic access and user-directed sharing are ambiguous | Label separate permission contexts; this observation is not proof of a backend security defect |
| Project model assumes one repo per project | Non-code and multi-repo efforts fit poorly | Use effort identity with linked resources |
| Skill readiness is simulated | A click can appear to prove an installation that did not happen | Show actual target/version/operation verification evidence |
| Initial task says choose hosted memory versus Git | Sample state conflicts with handoff's asserted storage decision | Update examples only after the real mechanism is settled |
| Preview assembly selects user/project memories only | Linked repository guidance can be omitted | Model and test project-to-repository context selection |

These are interaction and specification gaps, not reasons to discard the visual identity. Exact visual remedies remain proposals until vetted.

## Validation boundary

The supplied tests manipulate sample state. They use author-machine paths and a specific local server address. They do not prove native plugin availability, authentication, shared persistence, script execution, source permissions, or actual phone-to-laptop retrieval.

The latest review inspected Book, Left off, Apps, Skills, and Settings rendering and relevant interaction code. The preserved preview also illustrates the blocked-app handoff ambiguity. It was not a complete accessibility audit, exhaustive browser test, or certification of every flow.
