# JEFF handoff

Everything from the JEFF rethink, in one place: the decisions, the two reports and their reviews, and the working design prototype with its source.

Start with `DECISIONS.md`. It is the short version of every product and design call made so far, with the reasons and the open questions.

## What is here

```
jeff-handoff/
├── README.md                     this file
├── DECISIONS.md                  every decision, why, and what is still open
├── design/
│   ├── Main.dc.html              the working prototype: laptop + phone sharing one book
│   ├── Direction.dc.html         look board: palette and the three type pairings
│   ├── canvas.json               canvas layout and the "try it" note
│   ├── _helmet.txt               shared styles pasted into each artboard
│   ├── jeff-companion.html       the assembled canvas as last published
│   ├── preview.png               screenshot of the prototype in play mode
│   ├── archive/                  earlier versions and the static option boards
│   └── tests/                    headless browser scripts that click through every flow
└── reports/
    ├── JEFF-portable-context-report.md   Codex's report, revised after review (the plan)
    ├── jeff-porting-map.html             Claude's first map of where each JEFF piece goes
    ├── JEFF-v1-visual-direction.md       Codex's first visual direction
    ├── JEFF-v2-product-design.md         Codex's product brief for the companion
    ├── JEFF-v2-task-source-plugins.md    Codex's task backend boundary note
    └── codex-mockup-*.png                the first mockup, for contrast
```

## Live links

- Design canvas (Claude Design, editable, play button runs the prototype):
  https://claude.ai/code/artifact/ea72cb11-b315-4170-a290-d5263e194b4f
- Porting map report:
  https://claude.ai/code/artifact/9003e098-073d-4a45-89d6-c95591e22c50

## Working on the design

The three files in `design/` are the source. `jeff-companion.html` is built from them.

- Edit `Main.dc.html`, `Direction.dc.html`, or `canvas.json`.
- Rebuild the canvas from Claude Code with `/design` (it seeds a fresh copy of the editor with these files) and republish to the same artifact URL.
- Or open `jeff-companion.html` in a browser for a read-only view of the last build.

The artboards use the Claude Design component format: one `.dc.html` per artboard, `{{holes}}` filled from `renderVals()`, `<sc-if>` and `<sc-for>` for control flow, click handlers as `onClick="{{fn}}"`. Copy is literal text in the markup so it can be edited in place.

## Verifying the prototype

The scripts in `design/tests/` drive the assembled canvas in headless Chrome through Playwright and assert every flow. They expect the canvas served at `http://localhost:8765/jeff-companion.html`:

```bash
cd design && python3 -m http.server 8765
```

```bash
node design/tests/pw-resume.cjs
```

The Playwright path inside the scripts points at the copy under `~/.cache/codex-runtimes`. Change it if that moves. Note: the in-app browser pane in Claude Code cannot click inside the canvas's sandboxed frames, which is why these scripts exist.
