# Visual direction

8 September 2026. Current user-supplied direction; final typography, navigation, and dark theme remain open.

## The idea

A notebook contains the things you deliberately keep. Physical controls express what the connected apps can do. This gives Satchel's content and its configuration different visual roles while keeping them in one recognizable object.

The name Satchel extends that idea to a portable collection of papers and tools. It does not require adding decorative luggage imagery or carrying the metaphor into every label.

## Palette in the supplied prototype

| Role | Value | Intended use |
|---|---|---|
| Paper | `#F4F0E7` | Reading and writing surface |
| Ink | `#1F1B17` | Main content and paper links |
| Hardware | `#26231F` | Framing and control surfaces |
| Orange | `#E4571E` | Selected physical controls and ribbon accents |
| Correction red | `#B4271B` | Corrections/history treatment; warning semantics need refinement |
| Green LED | `#3E9E62` | Positive status, accompanied by text |
| Amber LED | `#E2A11E` | Incomplete or limited state, accompanied by text |

Use restrained surface depth, quiet separators, understated paper grain, tactile keys, and clear selected states. These are prototype values, not a complete accessible token system. Contrast, focus, disabled states, and semantic color usage need validation.

The dark enclosure is part of the light composition. It does not implement dark mode. Light, dark, and system preference behavior need explicit theme work across content, controls, overlays, inputs, errors, and focus states.

## Typography alternatives

| Option | Content | Interface | Readouts |
|---|---|---|---|
| Serif book | Newsreader | Instrument Sans | DM Mono |
| Grotesk | Schibsted Grotesk | Schibsted Grotesk | JetBrains Mono |
| Typewriter | Courier Prime | Instrument Sans | DM Mono |

The latest review preferred Serif book for separating authored content from controls. That is a recommendation, not the user's final font selection. Instrument Serif was previously rejected in the handoff's account.

Use technical readouts sparingly. Provenance is useful, but action links and critical state should not become hard to read because every detail is rendered in tiny uppercase monospace text.

## Layout and voice

The supplied desktop uses vertical spine tabs and a generous paper area. The phone uses a single column and four bottom destinations. Side-by-side devices share sample state to communicate continuity. This is a presentation artboard, not proof of a responsive implementation.

Copy should address the user directly and explain the action or state: “Said on your phone,” “Setup required,” or a concrete next step. Keep marketing slogans out of working screens. State source, audience, and destination when they matter to a sharing decision.

Do not restore the generic dashboard composition the user rejected: decorative overview cards, broad marketing explanations in the workspace, or a color change presented as a complete design system.

## Remaining design work

- Choose final type pairing and initial destination.
- Develop a complete dark theme and semantic design tokens.
- Evaluate rotated navigation for scanning, keyboard access, and localization.
- Scale project/scope selection beyond the sample's handful of chips.
- Decide how correction history appears without crowding the active record list.
- Design real installation, authorization, verification, offline, conflict, and revoked-access states.
- Confirm narrow layouts, touch targets, text resizing, long titles, empty lists, and large collections.

Keep the material identity while testing whether each physical metaphor helps the actual task. Functionality should follow the product model in [docs](../docs/README.md).
