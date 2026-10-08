# The daily log

`~/satchel-daily/log.md` is one file with every run in it, newest at the bottom. The reports say what the pass did. The log says what the review did: what it read, what it wrote, what it changed, and what it left for a person. So anyone can open one file and see every day at a glance, without opening a report.

Every run adds one entry, including a run where nothing ran and a second run on the same day. `collect.mjs --mark F` refuses to mark a folder the log does not name, so an entry is written before the window is recorded as reviewed.

It holds no conversation text. Session ids, numbers, file paths, commit hashes and PR links only, never the person's words.

## Shape

Append this to the end of the file. Leave out a line only when it says "none".

```markdown
## <date> · <folder name>

- window: <since> to <until> · <n> jobs · <n> runs · <n> sessions read · <n> waiting now
- blind reads: <n> agents · <n> changes · or "skipped, nothing ran"
- numbers: pipeline <n> vs blind <n> changes · topic-scoped <n> vs <n> · <n> from unlinked sessions · intents <n> vs <n>
- TODOs: added #<n>, #<n> · done #<n> (<commit>) · carried <n> · or "none changed"
- report: <folder>/report.md
- changes beyond the review: none
- watch next: <what the next review should check first>
- marked through <until>
```

"watch next" is the handoff to tomorrow: a fix that just merged and the number that should move because of it, a TODO close to done, or something odd that one night could not settle. The next run reads it before anything else.

"changes beyond the review" is everything that touched something outside the report folder, one line each:

- a replay: which folder, which checkout, the result row
- an eval run: which cases, how many repeats, the result
- a commit, a PR, a merge: the hash or the link, and one line on what it changed
- a file removed or rewritten: which one and why

In the scheduled run this line names step 8's PR, its merge commit or why it did not merge, and the eval calls it spent. Anything else the entry says who asked for.

## Example

```markdown
## 2026-09-25 · 2026-09-25

- window: 2026-09-24 00:00 IST to 2026-09-25 12:21 IST · 1 job · 26 runs · 26 sessions read
- blind reads: 4 agents · 32 changes
- numbers: pipeline 2 vs blind 32 · project-scoped 1 vs 18 · intents 0 vs 1
- TODOs: added #1 to #9
- report: 2026-09-25/report.md
- changes beyond the review, asked for by Neeraj in the same session:
  - replay of 26 sessions, old vs the scope branch: changes 1 to 4, project-scoped 1 to 3
  - PR NeerajG03/satchel#5 merged as 2b5462d: unlinked sessions may file under a topic (TODO #9)
- watch next: topic-scoped changes from unlinked sessions should go above 0 on the next night with a run
- marked through 2026-09-25T06:51:23Z
```
