# Acceptance per screen

17 September 2026. One block per board. "Done" means every line holds. Text comes from [copy.md](copy.md); values from [tokens.css](tokens.css); routes from [screen-map.md](screen-map.md).

## Shell (every signed-in page)

- Hardware frame paints the whole box. Paper is an inset panel. No light corners at any radius.
- Rail shows six items, current one as a paper pill with an orange dot, `aria-current="page"`. Rail never lists projects.
- Header shows wordmark in Caveat, date, one light plus a word, account handle.
- Footer readout present on every page. Left slot holds counts and success text; right slot holds the fixed line. Success text is announced through a live region and does not disappear on its own.
- Reload on any route lands on that route. Back works between every pair of pages.
- Signed out on any route shows Welcome; after sign-in, returns to that route.

## Welcome

- Shown only when signed out.
- One primary button. Under it, the one-line note about GitHub.
- Sign-in failure shows the red panel in place under the button. Nothing else on the page changes.
- Instance-not-set-up state shows the existing notice instead of the button.

## Left off, first run

- Shown when the user has zero memories, zero tasks and zero connections.
- Three steps in a row, each with one action that goes to Book, Apps, Tasks.
- If projects exist but are all empty, the amber notice names them and links to Projects.
- Header light is amber with "Nothing saved yet".

## Left off

- Lists actionable tasks first (status ready or in progress, has next action, no unfinished dependency), then blocked, newest activity first.
- Each row: project, scope word, state chip, "Next: …", provenance line, Open task.
- Under the list, a count of tasks waiting on something and a link to Tasks.
- Aside shows the newest memory across all scopes with its provenance, and each connection with a light and a phrase.
- Load failure shows the red panel in place with Reload; skeleton rows behind it at 40% opacity.

## Book

- Scope from the query; default For me. Picker button reads "In {scope}".
- Picker opens on click and on Enter; search filters as you type; For me pinned; each project shows a count; empty projects show "empty" in amber; New project at the bottom. Escape closes it.
- Picker is disabled while a draft or correction is open, with the reason shown under it.
- Composer collapsed to a single line until focused; expands to Name and Description; More info behind a disclosure. Save disabled until Name and Description are non-empty. Counter shown for More info.
- Entries show name in Newsreader, description, provenance, Correct, Read more info, and "N revisions" only when N > 1.
- Correcting swaps the entry for the editor in place with "will save as revision N". Other entries dim to 60%.
- Forget shows the confirm panel inside the entry. Forget removes the entry with the 180 ms fade then 200 ms collapse. Footer reads "Forgotten".
- Save success: entry settles in at the top, ink line draws under it once, footer reads "Saved to your book · revision N".
- Save failure and revision conflict show in place under the composer or editor, per copy.
- Empty scope shows the prompt chips; clicking one prefills Name and Description.

## Book search

- Typing in the search field sets `q`; results replace the list; matched text wrapped in `<mark>`.
- Segments count matches by where they matched.
- "Search all scopes instead" widens to every scope the user owns and says so in the lede.
- Clear removes `q` and restores the list without changing scope.
- Footer reads "{n} of {total} match "{q}"".

## Tasks

- Scope picker identical to the Book's.
- Segments filter by derived state. Actionable is the default view when it has items, else All.
- Search matches title and next action.
- Row: title, chip, "Next: …", provenance; blocked rows add the red reason line.
- Done tasks hidden by default with a count and Show done.
- Capture composer: Title and Next action required for Ready; Title alone captures into Inbox. Priority defaults to Medium.
- Empty scope shows the empty block with a link to the filled example.

## Task detail

- Stepper shows the five states with the current filled.
- Next action panel is the first thing under the heading; Copy handoff copies the latest handoff as plain text and the footer confirms.
- Composer has three modes. Comment needs body. Progress needs summary. Handoff needs next action and validation lines. Reference checkboxes list verified resources only.
- Timeline newest first, each entry labelled Handoff, Progress update or Comment, with the structured rows shown only when present.
- Right column: Outcome, Done when as checkboxes (read-only here), Planning with actionability and links to parent, children, dependencies and dependents, Resources with Open or Download, Technical history collapsed.
- Move to menu lists the four other states. Choosing Blocked opens the sheet. Other states move at once and the footer confirms.

## Move to Blocked sheet

- Sheet over a scrim, focus trapped, Escape cancels.
- Blocker textarea required.
- Confirm performs one call that records a progress update with status `blocked` and the reason as its body, and advances the revision once. The timeline shows the new entry on return.
- Footer reads "Moved to blocked".

## Task edit

- Fields prefilled from the task. Done-when is one line per criterion.
- Save writes with the revision the page loaded. On conflict, the red panel appears above the form with Show revision N, Keep my text as a new draft, Discard mine.
- Discard returns to the task without a prompt if nothing changed; with a prompt if something did.
- State is not editable here.

## Projects

- Table columns per copy. Counts come from real data. Empty projects show "Nothing saved here yet." and no repositories.
- New project opens the sheet; Create lands on the new project's page.
- Duplicate name prompts before creating a second.

## Project page

- Brief shown in Newsreader with Edit brief inline.
- Linked codebases with Link another and Unlink.
- Apps that can see this project, each with a light and its grants.
- Activity across this project's tasks and memories, newest first.
- Tasks and Memories previews with links to the scoped lists.
- Empty project leads with the amber notice and the brief field; three starts below.

## Apps

- Cards per active connection with light, status phrase, Memory and Tasks rows and Revoke access. Revoked connections are not listed (decided 17 September: the list shows only what can read now). Edit scopes is not in v1; widening a grant means revoke and reconnect from the app.
- Revoke confirms in place, then the footer reads "{app} access revoked".
- Empty state shows the three steps and the MCP address in a copyable block.

## Consent

- Entry when `authorization_id` is present. Client name and return address shown.
- Two groups side by side. Each has Select all and None and a live "n of total" count. Quick-start row sets both groups.
- Allow disabled until at least one scope is chosen. Deny always enabled.
- Allow performs the grant then approves; lands on the Connected page for that client.

## Connected

- Left half Satchel, right half the partner's colours and type per board. No logos.
- Two actions: Back to Apps, Return to {app}. The return link uses the redirect the app supplied.

## Settings

- Account row with Sign out. Export all and Export one project. Forgetting explanation with a link.
- No Appearance row. No delete row.

## Errors and readouts

- Every error is in place, red border, three parts: what failed, what is safe, one action.
- Every success is a footer readout, announced once, not a toast.

## Components

- Every interactive element is a real `<button>`, `<a href>`, `<input>`, `<select>` or `<textarea>`. No click handlers on `div` or `span`.
- Focus ring visible on every control: 3 px accent on paper, 3 px orange on hardware, 3 px offset.
- Picker rows truncate to one line with the full name in `title`. Titles and descriptions wrap. Chips and provenance never wrap.
- Name limit 120 with a counter; title limit 200; both shown when the user passes 80%.
- All motion honours `prefers-reduced-motion`.
