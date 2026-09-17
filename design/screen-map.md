# Screen map and routes

17 September 2026. Six destinations, one rail, real URLs. Every board named here is on the [design canvas](https://claude.ai/artifact/E37216htrsgRJFEVwhshDc) and in [`canvas/project/`](canvas/project/).

## Shell

Hardware frame around a paper panel. The rail sits on the hardware at the left with six fixed destinations; it never lists projects, so nothing in it can grow. The header on the hardware shows the wordmark, device, date, a sync light with a word, and the account. The paper has a footer readout on every page: a left slot for counts and success messages, a right slot for a fixed line such as "Explicit saves only".

## Routes

| Route | Board(s) | Job | Notes |
|---|---|---|---|
| `/` | Welcome · LeftOffEmpty · Main | Signed out: welcome and GitHub sign-in. Signed in: Where you left off. | First run shows the three-step start instead of the task list. |
| `/book` | BookEmpty · Book | Save, read, correct, forget memories in one scope. | Scope in the query: `?scope=me` (default) or `?scope=project:<id>`. |
| `/book?q=` | BookSearch | Search within the current scope. | `q` alongside `scope`. Clear removes `q` only. |
| `/book` with a draft | BookCorrect · ScopePicker | Composer open or correcting one entry. Picker open. | Draft is page state, not a route. Picker locks while a draft exists. |
| `/tasks` | TasksEmpty · Tasks | List for one scope with filter segments and search. | Same `scope` query as the Book. Segments: Actionable, Moving, Blocked, Done, All. |
| `/tasks/:id` | Task · TaskBlocked | Task detail: state stepper, next action, composer (comment, progress, handoff), timeline, right column. | Move-to Blocked is a sheet over this page. |
| `/tasks/:id/edit` | TaskEdit | Edit title, next action, outcome, why, done-when, priority. | Save writes with the current revision. Conflict shown in place. |
| `/projects` | Projects | List with memory, task and app counts. | |
| `/projects/new` | ProjectNew | Sheet over the list: name and brief. | Create lands on `/projects/:id`. |
| `/projects/:id` | Project · ProjectEmpty | Brief, linked codebases, apps with access, activity, tasks, memories. | Empty version leads with the brief field and three starts. |
| `/apps` | AppsEmpty · Apps | Connected apps with lights, scopes and revoke. | Empty version is the three install steps. |
| `/apps/consent?authorization_id=` | Consent | An app asks for access. Memory and Tasks side by side, Select all / None, quick-start row. | Already the entry point when `authorization_id` is present. |
| `/apps/connected/:client` | ConnectedClaude · ConnectedCodex | Plain split acknowledgement after Allow. | Right half follows the partner's look. No logos. |
| `/settings` | Settings | Account, export, forgetting explained. | No Appearance, no delete. |

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
    memories/ Book.tsx  Composer.tsx  MemoryEntry.tsx  BookSearch.tsx
    tasks/    TaskList.tsx  TaskDetail.tsx  TaskEdit.tsx  BlockedSheet.tsx  Timeline.tsx  UpdateComposer.tsx
    projects/ ProjectList.tsx  ProjectPage.tsx  NewProjectSheet.tsx  RepositoryLinks.tsx
    connections/ Apps.tsx  Consent.tsx  Connected.tsx
    settings/ Settings.tsx
```

Existing repositories (`features/*/repository.ts`) and models stay. The shell and features above replace `Workspace.tsx`, `TaskWorkspace.tsx`, `Connections.tsx` and the view switch in `main.tsx`.

## Not in v1

- Dark theme (one reference board: BookDark).
- Phone layouts (four reference boards). The phone becomes a native Android app with app intents.
- Skills. Removed from the project.
- Resume. Satchel holds context; it does not launch work.
- Correction history view. The "N revisions" link exists; what it opens is v2.
