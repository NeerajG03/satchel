# JEFF V1 visual direction

Design study · 6 September 2026 · proposed refinement, not a scope expansion

## The design problem

The first mockup established a useful layout but made almost every object a similarly rounded, softly colored card. That flattened the hierarchy: a configuration problem, a saved decision, a source reference, and a primary action looked like variations of the same thing. It was legible but did not give JEFF a strong identity or make its purpose immediately visible.

Keep the sidebar, main workspace, secondary attention area, and simpler Android navigation. Change how the interface explains itself and how its elements relate.

## Start with the job

JEFF is a companion for a personal AI setup. It needs to answer three questions quickly:

1. **Where does this context come from?** Show the memory source, project scope, source reference, and revision.
2. **Which app can use it?** Show effective read/save access and the relevant client/device.
3. **What needs my attention?** Surface a concrete configuration gap with a direct route to fix or test it.

This suggests an interface with the precision of a useful instrument and the warmth of a personal workspace. Decorative intelligence scores, activity charts, animated agents, and transcript feeds do not help those questions.

## The recommended direction

Use crisp neutral surfaces with a deliberate cobalt accent, confident typography, restrained elevation, and a visible context path. The refinement should feel recognizably JEFF even without a large logo.

The overview's focal point is **shared memory → project/access scope → connected apps**. Each part is inspectable. It describes a real relationship in the product, rather than occupying space with an abstract illustration. The counts are derived from the prototype's actual sample records and configured apps, not invented performance indicators.

The source path, consistent provenance formatting, and controlled use of the accent form the identity. A large hero slogan should not be necessary to explain the product once the user is configured.

### Typography

Space Grotesk gives the headings a more distinct structure. DM Sans keeps descriptions and forms comfortable to read. IBM Plex Mono is reserved for compact provenance, revision, and system labels; it is not used for paragraphs.

Large type establishes page identity; medium type names the object or problem; smaller, readable text provides source and context. Avoid making everything bold. Avoid shrinking important setup information to make more cards fit.

### Surfaces and geometry

Use a quiet application canvas, a slightly differentiated navigation region, and raised surfaces only for bounded objects or groups. Lists can share a surface and use dividers. Service references can be rows. A recent decision can be a typographic excerpt rather than another card.

The primary context surface has a narrow accent edge and a clearly organized source path. An attention item has a semantic warning marker and a concrete action. They have different visual treatments because they serve different jobs.

Buttons, inputs, and navigation items have tighter corners than content surfaces. This creates hierarchy without introducing a different shape for every component. Keep touch targets comfortable even when the visible control is compact.

### Color

Use cobalt for actions, selected state, and the context path. Reserve amber for an actionable limitation, red for a destructive/error state, and green for a verified successful condition where one is actually known. Pair every status color with a label.

The main palette is neutral so work and personal content do not inherit arbitrary category colors. Do not imply an agent is connected or a save succeeded through a reassuring accent alone.

Two accent directions are available in the design controls:

- **Cobalt:** more precise and technical; the recommended default for a configuration companion.
- **Vermilion:** warmer and more personal, using the same hierarchy and geometry. It is an alternative identity, not another product mode.

Keep one preferred direction in the product. The alternatives are for evaluation rather than a commitment to ship a theme builder.

## Light and dark are equally designed

| Layer | Light | Dark |
|---|---|---|
| Canvas | Cool near-white | Deep graphite |
| Object surface | White, with subtle border/elevation | Raised charcoal, visibly separate from the canvas |
| Primary text | Deep neutral ink | Soft near-white |
| Secondary text | Slate that remains readable | Muted gray with enough contrast against the actual surface |
| Accent | Saturated cobalt | Lighter blue with a dark readable foreground on filled actions |
| Warning | Amber text on a pale warm surface | Soft amber on a darker warm surface |

Do not invert every color or simply apply a transparent black overlay. A dark surface needs its own border, separation, and action contrast. Avoid pure-black backgrounds paired with pure-white paragraphs for the entire interface.

The product offers **Light, Dark, and System**. Desktop exposes the switch in the navigation area; Configuration also provides the full control. Android has a compact appearance control in the header and the explicit choices in Configuration. Changing appearance preserves the current form draft and navigation state. It is an appearance preference, not a server configuration change.

The mockup keeps the preference in its local preview state. Persisting a device preference belongs in the actual application implementation.

## Refine each surface around its purpose

| Surface | Design emphasis |
|---|---|
| Overview | A recognizable context path, current app access, and the next actionable configuration gap |
| Connections | App/device identity, concise permission state, and a direct path to the effective access details |
| Memory | The statement first; source, scope, and revision immediately available; correction/history remain clear actions |
| Projects | Brief and source ownership; the task backend stays GitHub Issues in V1 |
| Skills | Purpose, installation target, capability class, and version; instruction access is distinct from execution |
| Configuration | Grouped form sections, clear ownership, and no plugin placeholders or future-feature controls |
| Context preview | Exactly what the selected client can receive, with current revisions and source references |
| Failure state | What failed, what remains saved or unsaved, and the next useful action |

The visual design must not hide permission limits or copy failure details into low-contrast footnotes. A polished success state paired with vague failure handling is not a complete design.

## Interaction and accessibility

Controls should respond to hover, keyboard focus, press, selection, loading, success, and failure consistently. Use small, quick transitions to explain selection or navigation; avoid decorative looping motion. Honor reduced-motion preferences.

Keep actions accessible without hover. Preserve native keyboard behavior and visible focus. Forms should retain drafts on failed saves; mode switching must not rebuild and clear the form. A source or scope change that affects what an agent can access needs visible acknowledgement.

Mobile should preserve the same mental model, not squeeze the desktop into a small rectangle. The route becomes a vertical path; the main content becomes one column; secondary overview material can move out of the first screen. Essential actions remain available through navigation.

Production acceptance should include normal/large text sizes, keyboard navigation, both themes, real Android touch use, and contrast checks on text and non-text controls. A good screenshot is one check, not proof of complete accessibility.

## Scope and review

This study retains the approved V1 boundaries: GitHub Issues only for tasks; no plugins, personas, curator, or new agent runtime. All data and integrations in the previews are simulated. The earlier mockups remain unchanged as a comparison point.

Review the new direction across Overview, Memory, Connections, and Configuration in both modes. The useful decision is whether the interface now communicates ownership and next actions more clearly while feeling like a product you would enjoy using—not whether it contains more visual effects.

## Prototype verification

The refined prototypes passed the existing interaction checks for correction/history, current retrieval, connection failure/repair, access denial, failed-save draft retention, skill setup, and Android navigation/save/forget. Checked content widths from 320 to 1,048 pixels had no horizontal overflow. Explicit Light/Dark selection and System appearance were exercised; changing appearance retained the current draft. Representative primary, secondary, warning, and navigation-support text passed a 4.5:1 contrast check in both themes. This is targeted prototype verification, not a comprehensive accessibility audit or a test of real integrations.
