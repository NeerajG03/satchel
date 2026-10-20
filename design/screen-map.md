# Screen map and routes

17 September 2026, tasks removed 20 October 2026. Five destinations, one rail, real URLs. Every board named here is on the [design canvas](https://claude.ai/artifact/E37216htrsgRJFEVwhshDc) and in [`canvas/boards/`](canvas/boards/).

## Shell

Hardware frame around a paper panel. The rail sits on the hardware at the left with five fixed destinations: Left off, Book, Topics, Apps, Settings. It never lists topics, so nothing in it can grow. A sixth, Activity, appears only when developer mode is switched on in Settings, which is a person turning it on for themselves rather than the list growing on its own. The header on the hardware shows the wordmark, device, date, a sync light with a word, and the account. The paper has a footer readout on every page: a left slot for counts and success messages, a right slot for a fixed line such as "Explicit saves only".

## Routes

| Route | Board(s) | Job | Notes |
|---|---|---|---|
| `/` | Welcome · LeftOffEmpty · Main | Signed out: welcome and GitHub sign-in. Signed in: Where you left off. | First run shows the three-step start instead of the newest memories. |
| `/book` | BookEmpty · Book | Save, read, correct, forget memories in one scope. | Scope in the query: `?scope=me` (default) or `?scope=topic:<id>`. |
| `/book?q=` | BookSearch | Search within the current scope. | `q` alongside `scope`. Clear removes `q` only. |
| `/book/archive` | none yet | Memories that stopped loading: forgotten, replaced, retired or expired. Put it back, or delete for good. | Scope-free on purpose: what was put aside is one list, and it is short. |
| `/book` with a draft | BookCorrect · ScopePicker | Composer open or correcting one entry. Picker open. | Draft is page state, not a route. Picker locks while a draft exists. |
| `/topics` | Topics | List with memory and app counts. | |
| `/topics/new` | TopicNew | Sheet over the list: name and brief. | Create lands on `/topics/:id`. |
| `/topics/:id` | Topic · TopicEmpty | Brief, linked codebases, apps with access, activity, memories. | Empty version leads with the brief field and three starts. |
| `/apps` | AppsEmpty · Apps | Connected apps with lights, scopes and revoke. | Empty version is the three install steps. |
| `/apps/consent?authorization_id=` | Consent | An app asks for access. Memory by scope, Select all / None, quick-start row. | Already the entry point when `authorization_id` is present. |
| `/apps/connected/:client` | ConnectedClaude · ConnectedCodex | Plain split acknowledgement after Allow. | Right half is the partner’s colour (Claude clay, Codex black) with the partner’s mark faint behind the text. |
| `/settings` | Settings | Account, overnight pass (switch and schedule), developer mode, forgetting explained. | No Appearance, no delete, no export until there is a memory export. |
| `/settings/consolidation` | none | Where the consent page sends the overnight pass back. Swaps the code, stores the token, returns to Settings. | No content of its own. Shows a skeleton, or the reason it failed with Back to Settings. |
| `/activity` | none yet | Developer mode. Every request, document and memory change in one stream, newest first, each row expandable. | Reachable by address always; the rail item appears only when the Settings switch is on. Read-only. |

Unknown routes go to `/`. A signed-out visit to any route shows Welcome and returns to that route after sign-in.

## Component shape

```
src/
  app/
    routes.tsx          route table, guards for signed-out
    Shell.tsx           frame + header + rail + paper + footer readout
  shell/
    Rail.tsx  Header.tsx  Paper.tsx  Footer.tsx  ScopePicker.tsx  Sheet.tsx  Notice.tsx
  features/
    leftoff/  LeftOff.tsx  LeftOffEmpty.tsx
    memories/ Book.tsx  Archive.tsx  Composer.tsx  MemoryEntry.tsx  BookSearch.tsx
    topics/   TopicList.tsx  TopicPage.tsx  NewTopicSheet.tsx  TopicDelete.tsx  RepositoryLinks.tsx
    connections/ Apps.tsx  Consent.tsx  Connected.tsx
    settings/ Settings.tsx  Overnight.tsx  ConsolidationCallback.tsx  consolidationConnect.ts  schedule.mjs  repository.ts
    activity/ Activity.tsx  model.ts  repository.ts
```

Existing repositories (`features/*/repository.ts`) and models stay. The shell and features above replace `Workspace.tsx`, `Connections.tsx` and the view switch in `main.tsx`.

## Not in v1

- Dark theme (one reference board: BookDark).
- Phone layouts (four reference boards). The phone becomes a native Android app with app intents.
- Skills. Removed from the project.
- Tasks. Removed on 20 October 2026. Satchel is memory and topics; tasks live in Notion.
- Resume. Satchel holds context; it does not launch work.
- Correction history view. The "N revisions" link exists; what it opens is v2. Developer mode's Activity page shows the same events as a machine readout, which is not the same thing: it is the raw record, not a history a person reads next to an entry.
