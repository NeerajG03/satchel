# Visual direction

17 September 2026. Settled for v1. Values live in [`tokens.css`](tokens.css); this page explains them.

## The idea

A notebook with physical controls. Paper is for what you wrote. Hardware is for what the connected apps may do. The two never share a surface: a memory is never on hardware, a permission switch is never on paper.

## Composition

The hardware is the outer box and paints everything, including the header and rail. The paper is an inset panel with a smaller radius. This is not a border trick, so there is no corner where two backgrounds fight. The live site's light corners came from the old one-box approach; `background-clip: padding-box` on `.shell` is the interim fix until the shell is rebuilt.

Desktop first. The frame is designed at 1280 wide and should fill a laptop window. There is no phone layout in v1.

## Colour

| Role | Value | Use |
|---|---|---|
| Paper | `#F4F0E7` | Reading and writing |
| Paper 2 / 3 | `#EDE7DB` / `#E4DCCD` | Fields, panels, pressed |
| Ink | `#1F1B17` | Text, the primary button on paper |
| Muted | `#6B6257` | Secondary text. 5.2:1 on paper |
| Line | `#D9D1C4` | Separators only |
| Hardware | `#26231F` | Frame, header, rail |
| Key | `#332E28` | Raised control on hardware |
| Orange | `#E4571E` | Selected control on hardware, focus ring on hardware |
| Accent | `#B8451A` | Links and accent text on paper. 4.6:1 |
| Red | `#A82720` | Destructive and blocked text and borders |
| Green / Amber text | `#2E7A4A` / `#8A5E00` | Status words |
| LEDs | green `#3E9E62` · amber `#E2A11E` · red `#C8442E` · off `#6E665C` | Always next to a word |

Rules. Orange is never used for text on paper; accent is. A light never stands alone. Red is for things that stop you or delete. Green appears only after something was actually verified.

## Type

| Face | Job | Weights |
|---|---|---|
| Newsreader | Content and page headings: memory names, task titles, quotes, H1 to H3 | 400, 500 |
| Instrument Sans | Interface: labels, buttons, descriptions, body | 400, 500, 600 |
| DM Mono | Readouts only: eyebrows, provenance, counts, footer | 400, 500 |
| Caveat | The wordmark, nowhere else | 600 |

Mono is never used for an action or for critical state. Handwriting is never used on paper. Sizes are in the tokens file.

## Controls

- Hardware key: raised, drops 1 px on press. Selected is orange with ink text.
- Rail item: 44 px tall, paper-coloured pill when current, dot turns orange.
- Button on paper: 40 px, radius 8. Primary is ink with paper text. Quiet has no border. Danger is red.
- Chip: mono uppercase, pill, outlined. States: ready (ink), in progress (accent), blocked (red), done (dashed muted).
- Stepper: five stops, the current one filled ink.
- Field: paper 2 with a line border. Content fields use Newsreader.
- Sheet: 520 wide, over a 40% ink scrim, radius 14.
- Picker dropdown: 360 wide, search on top, For me pinned, projects with counts.

## Voice

Address the user. Say the source and the destination. "Said on your phone." "Reads only." "Forget removes it from retrieval; copies in old chats stay." Plain words, short sentences. No slogans inside working screens. Errors say what failed, what is safe, and one thing to do.

## Motion

One curve, `cubic-bezier(.2,.7,.2,1)`. Three durations: 120 ms taps, 180 ms hovers and fades, 320 ms settles. Entries rise 6 px and fade in, staggered 40 ms. The verify light runs once, amber to green with one ring. Errors, confirmations and the consent page never animate in. Reduced motion turns everything into a swap. See the Motion board.

## Out of scope for v1

Dark theme. Phone. Both are v2, see [decisions.md](decisions.md).

## The mark

The logo is the shell shrunk to a square: hardware frame with radius 22 on a 180 grid, paper inset 14 with radius 14, a 22 tall header band, one orange LED at top right, and a Caveat 600 "s" in ink on the paper. Below 32 px the "s" is dropped and the three shapes carry it. The light is always orange in the logo. State colours belong to the app. Wordmark is "satchel" in Caveat 600, paper ink on hardware, gap to the mark 42% of the mark's height. Files and grid notes are in [mark/](mark/).
