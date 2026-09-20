# Satchel design

The direction is **a personal notebook with physical controls**. Paper is for what you wrote. Hardware is for what the connected apps may do. This folder is the handoff pack for building the v1 web app.

## The canvas

The mockups are on the design canvas: <https://claude.ai/artifact/E37216htrsgRJFEVwhshDc>. Every artboard is a clickable prototype; rail items and buttons link between screens. The same artboards are checked in under [`canvas/project/`](canvas/project/) as `.dc.html` files, and [`canvas/gen.mjs`](canvas/gen.mjs) generates them, so a change to the shared CSS lands on every board at once.

Rows on the canvas, top to bottom:

1. Design system, the mark, motion, the corner fix, and the heading font question
2. Arrive: sign in, first run, then where you left off
3. The book: empty, filled, correcting and forgetting (dark theme board is a v2 reference)
4. Projects: list, a full project, a brand new one
5. Tasks: empty, list, task detail with timeline
6. v1 details: the picker open, sheets, edit, search, errors, and component states
7. Apps and settings: empty, connected, consent request, Satchel × Claude, Satchel × OpenAI, settings
8. v2 reference only: phone boards (the phone becomes a native Android app)

## Read in this order

1. [Decisions](decisions.md): the ledger. Settled choices with dates and reasons.
2. [Visual direction](visual-direction.md): colour, type, controls, voice, motion, the mark.
3. [Mark](mark/): the logo files. Full mark, favicon, and the lockup.
4. [Tokens](tokens.css): the values, as CSS custom properties. Use this file in the app.
5. [Screen map and routes](screen-map.md): every route, which board it is, the component shape.
6. [Copy deck](copy.md): every string, by page.
7. [Acceptance](acceptance.md): what "done" means per screen.
8. [Accessibility](accessibility.md): the checklist to tick per screen.
9. [Build order and data gaps](build-order.md): the sequence, and what the boards show that the code does not have yet.

## Not in v1

Dark theme, phone layouts, Skills, Resume, correction history view, account delete. See the decisions ledger for why.

## History

`mockup/` is the 10 September Satchel-named copy of the earlier prototype, and `prototype/` is the original JEFF-named bundle with its archived artboards and browser scripts. `archive/early-codex-mockups/` holds the rejected forest and cobalt explorations. [`review-notes.md`](review-notes.md) is the 8 September review of that prototype. All of these are history. Build from the canvas and the files listed above, not from them.
