# Copy deck

17 September 2026. Every string a developer needs, by page. Plain words. Address the user. Say source and destination. No slogans inside working screens. Dates and names in examples are sample data.

## Shell

| Where | Text |
|---|---|
| Wordmark | satchel |
| Rail | Left off · Book · Tasks · Projects · Apps · Settings |
| Rail write key | Write |
| Header status (word next to the light) | Synced · Nothing saved yet · No apps connected · Project has nothing yet |
| Footer right, default | Explicit saves only |
| Footer left, examples | 5 in the book · 3 tasks moving · 2 apps |

## Welcome (signed out)

- Eyebrow: Your work, with you
- H1: A place for what you want to remember.
- Body: Keep the decisions, preferences and next steps that make a project yours. Write them once. Every connected AI app can read them.
- Button: Continue with GitHub
- Under button: GitHub is only used to sign you in. Satchel never asks for repository access here.
- Side list: The book / Preferences and decisions you chose to save. Names and short descriptions form an index agents read first. · Tasks and handoffs / The exact next action and the evidence the last session left behind. · Projects / One effort, its repositories and the apps allowed to see it. · Apps / Each connected agent gets only the scopes you grant. Revoke any time.
- Footer: Satchel · Private pilot — A little less repeating yourself

## Left off, first run

- H1: Welcome, {first name}.
- Lede: Your Satchel is empty, which is the right place to start. Do any one of these three and this page turns into "Where you left off".
- Step 1: 01 · Two minutes / Write the first thing down / A preference about how you like to work. It applies everywhere, no project needed. / Open the book
- Step 2: 02 · Five minutes / Connect an AI app / Install the Satchel plugin in Claude Code or Codex, then sign in from its connection settings. You choose what it can read. / See the steps
- Step 3: 03 · When you have one / Capture a task / A title and the next action. Later, a handoff makes it resumable from any device. / Capture a task
- Notice when projects exist but are empty: You have {n} projects but nothing in them yet. {names} were created earlier. A project with no memories or tasks is invisible to agents until you add something. / View projects

## Left off

- H1: Where you left off.
- Actions: All tasks · Write something down
- Section: Next actions · actionable now
- Row: Next: {next action} · {kind} · {app} · {device} · {when} · {resource note} · Open task
- Under list: {n} more tasks are waiting on something. See them in Tasks
- Aside: Last thing saved / "{description}" / Said on your {device} · {scope} · {when}
- Aside: Your apps / reads and saves · verified today / reads only · last read Fri / not connected / Manage apps

## Book

- Eyebrow: For me · Project · {name}
- H1: The book.
- Lede, For me: "For me" holds preferences and details that apply across all your work. Pick a project from the picker when something belongs to one effort only.
- Lede, project: {brief}
- Picker button: In {scope}
- Picker: Find a project · For me / applies everywhere · Projects · {n} · {name} / {n} memories · empty · New project
- Picker locked: Finish or discard the correction to switch scope. / Save or discard the draft to switch scope.
- Segments: All {n} · Saved by me {n} · Saved by agents {n}
- Composer: Write something down · saving in {scope} / Name · short, how an agent will find it / Description · one or two lines. This is what agents read first / Add more info (optional) / Name and description form the index. More info is read on demand. / Discard · Save memory
- Correcting: Correcting · will save as revision {n} / Revision {n-1} stays in history / Discard changes · Save correction
- Entry actions: Correct · Read more info · Hide more info · {n} revisions
- Provenance: Said on your {device} · {when} · revision {n} / Saved by {app} · {device} · {when} · revision {n}
- Forget confirm: Forget this memory? It stops loading right away and waits in the archive, so you can bring it back. Copies in earlier chats, exports and {app}'s own memory are not touched. Satchel can't reach those. / Keep it · Forget
- Forget footer: Forgotten · it is in the archive if you want it back
- Below the list: Anything forgotten, replaced or finished waits in the archive.
- Composer kind: What kind of thing is this · How things are (true until something makes it false) · How you like things (gets stronger each time you say it) · Something you want (ends when it is done)
- Entry provenance: handle {name} · {kind} · said {n} times · heard, not confirmed · revision {n}
- Empty: Ideas for a first memory / Start with something about you. / Things you end up repeating in every new chat make good first entries. Tap one to prefill the form above. / How I like answers written · Tools and languages I use · What to never do in my code · My working hours and timezone
- Search: Searching names, descriptions and more info in this scope. Search all scopes instead / Matches {n} · In name {n} · In more info {n} / matched in name and description / Not here? Memories saved in "For me" and other projects are not searched unless you widen the scope above. / Clear
- Footer: {n} in the book · {scope} / {n} of {total} match "{q}" / Saved to your book · revision {n} / Forgotten

## Tasks

- H1: Continue.
- Lede: Tasks hold the exact next action and the evidence a session leaves behind. They don't need a repository, and they don't need a project.
- Actions: Export · Capture
- Segments: Actionable {n} · Moving {n} · Blocked {n} · Done {n} · All {n}
- Search placeholder: Title or next action
- Row: Next: {next action} · {priority} · rev {n} · {kind} by {app} · {when} · {resource}
- Blocked row: Blocked: {reason} · Waiting on {n} tasks
- Under list: {n} done tasks are hidden. Show done
- Composer: Capture a task · saving in {scope} / Title / Next action · the one concrete thing to do first / Priority / Add outcome, why, and done-when / Starts in Inbox. Move it to Ready when it has a next action. / Capture task
- Empty: Nothing to continue yet. / Once a task exists, agents can record progress and handoffs on it. This list then shows what is moving, what is blocked, and the next action for each.
- No matches: No matching tasks. / Clear a filter to see the rest of this scope.

## Task detail

- Back: ← Tasks · {scope}
- Stepper: Inbox · Ready · In progress · Blocked · Done
- Actions: Edit · Move to · (more)
- Next action panel: Next action / {text} / Copy handoff
- Composer modes: Add a comment · Record progress · Record handoff / A handoff is the stronger boundary. It needs validation evidence.
- Composer placeholder: What changed, or what the next person should know.
- Reference checks: Reference {resource label}
- Timeline: Timeline · newest first / Handoff · Progress update · Comment / Completed · Validated · Decisions · Remaining · Blockers · Resources
- Right column: Outcome · Done when · Planning · Actionable now · no unfinished dependencies · Not actionable · waiting on {n} tasks · Parent: · Blocks: · Resources · Attach · Open · Download · Technical history · {n} events
- Move to Blocked sheet: Move to Blocked / What is in the way? / The reason shows on Left off and on the task list, so the next session knows what to clear first. / Blocker / This is recorded as a progress update with the reason as its body, so the timeline always shows why. One write, one revision. / {from} to Blocked · revision {n} / Cancel · Move to Blocked
- Edit: ← Back to task / Editing task · state does not change here / Title / Next action · the one concrete thing to do first / Outcome · what is true when this is done / Why · the reason it matters / Done when · one per line, each becomes a checkbox / Priority / Parent, dependencies and resources are edited on the task page, not here. / What this write does / Saves with the current revision. If an agent changed the task since you opened it, you get a conflict, not an overwrite. / Last change: {app} · {kind} · {when} / Discard · Save task
- Footer: Task · {scope} · revision {n} / Editing · revision {n} · save writes revision {n+1} / Moved to {state} / Comment added / Progress recorded / Handoff recorded

## Projects

- H1: Projects.
- Lede: A project is an ongoing effort, not a repository. Link as many codebases as it needs, or none at all.
- Columns: Project · Memories · Tasks · Apps with access · Last activity
- Row: No repositories linked · Nothing saved here yet.
- New project sheet: New project / Name the effort, not the repo. / A project can hold many repositories or none. You can link codebases on the next page. / Name / Brief · one or two lines an agent reads to tell this apart from your other projects / A project with the same name already exists? Satchel will ask before creating a second one. / Opens the new project page / Cancel · Create project
- Project page: ← Projects / Open its book · Open its tasks / Edit brief / Linked codebases · Link another · Unlink / A linked repository lets an agent pick this project for a coding chat. It does not grant access by itself. / Apps that can see this project · Manage / Activity / Tasks · {n} · All tasks / Memories · {n} · Open the book
- Empty project: Agents can't see this project yet. It has no brief, no memories and no tasks. Fill in the brief first so an agent can tell it apart from "{other}". / Brief · one or two lines an agent reads to know what this effort is / What is this project for, and what does "done" look like? / Save brief / You can change it any time. / Codebases / Link a repository / Optional. Lets a coding agent select this project when it opens that repo. / Book / Save a first decision / Something agents should know before working here. / Write in this project's book / Tasks / Capture the next thing / A title and next action is enough to start. / Capture a task

## Apps

- H1: Apps.
- Lede: Each app gets only the scopes you chose. A permission here applies to every installation using that app identity.
- Empty: Nothing is connected yet. An app gets only the memory and task scopes you grant when it first asks. You can revoke later. / 01 · In your terminal / Install the Satchel plugin / Both apps install from the same public catalog. Pick yours. / Claude Code · Codex / {install commands} · Copy / Or let {app} do it. Copy a prompt, paste it into a {app} chat, and it runs the install for you. / Copy prompt for {app} / 02 · In the app / Sign in / The login command opens Satchel in your browser with a consent page. Nothing is granted until you allow it. / {login command} · Copy / 03 · Back here / See it connected / The app appears in this list with a green light once you allow it. / Waiting for the first connection
- Empty footer panel: What a connected app can never do: read scopes you didn't grant, save without both write permission and your explicit ask, or see More info in bulk. Hooks read names and descriptions only.
- Card: Verified · read {when} / Connected · last read {when} · no writes granted / Revoked {when} · earlier retrieved content stays in that app / Memory / Tasks / read and save · read only · read, write and upload · none / Revoke access · Edit scopes · Reconnect from the app
- Footer: {n} apps connected · {n} revoked / {app} access revoked — Earlier reads stay in that app

## Consent

- Eyebrow: An app wants to connect
- H1: {app} wants to read your Satchel.
- Under: Name supplied by the app · will return to {redirect}
- Quick start: Read everything · Read and save everything · Clear all
- Groups: Memory / Scopes it can read · {n} of {total} / Select all · None / For me · personal memories / Also allow saves, corrections and forgets / Only when you ask it to, in that chat. — Tasks / For me · personal tasks / Also allow creating tasks, updates, moves and handoffs / Also allow file uploads to task storage
- Note: Projects you create later are not included. Add them from Apps.
- Actions: Allow this access · Deny · You can change or revoke this later in Apps.
- Aside: What this means / Reading means the app's hooks get the names and descriptions of memories in these scopes. It fetches More info by name only when it needs it. / Writing still needs your explicit ask inside the chat. The app cannot save on its own. / Summary
- Footer: Deny closes this and sends the app back

## Connected (Satchel × partner)

- Left: Connected / {app} can now read your Satchel. / Only the scopes you just allowed. Change or revoke them any time in Apps. / Back to Apps
- Right: Connection complete / Satchel is connected to {app}. / Sending you back so it can finish signing in. Your next conversation starts with your memory index already loaded. / Return to {app} now

## Settings

- H1: Settings.
- Account: {handle} · {email} / Sign out / GitHub is used only to sign you in.
- Take it with you: Export everything as a portable manifest plus your verified task files. No credentials are included. Identifiers, sources and revision history are kept. / Export all · Export one project…
- Developer mode: Adds an Activity page showing every request that came in, every conversation Satchel kept, and every change to a memory. Read-only. It is a view, not a permission: nothing about what is stored or who may read it changes. / Show Activity in the rail · this browser only / Open Activity
- Forgetting: Forget removes a record from active retrieval right away. Satchel cannot delete copies from earlier chats, exports, or an app's own memory. / Read how retention works
- Footer: Exported {file} + {n} files — No credentials included

## The book · archive

- Eyebrow: The book · archive
- H1: Not loading any more.
- Lede: Memories you forgot, ones replaced by something newer, and things you wanted that are now done. Nothing here reaches an agent. Everything here can come back.
- Why it is here: You forgot it · Replaced by a newer one · Done, so it was retired · Its date passed
- Actions: Put it back · Delete for good · Reload
- Delete for good: This is the only thing in Satchel that really destroys something. The memory and its whole history go, and nothing can bring them back. / Keep it · Delete for good
- Empty: Nothing has been put aside. When you forget a memory, or Satchel replaces one with something newer, or something you wanted gets done, it waits here instead of disappearing.
- Footer: {n} archived · Back in your book · Deleted for good — its history went with it

## Activity (developer mode)

- Eyebrow: Developer
- H1: What Satchel did.
- Lede: Every request that came in, every conversation kept, and every change to a memory, in the order it happened. Read-only, and yours alone.
- Filters: All · Requests · Documents · Memory
- Row kinds: Session start · Prompt · Capture · Consolidation · Document · Memory
- Row actions: Look / Hide · Reload
- Detail headings: What was typed · Sent · Returned · Before · After · The conversation
- Empty (All): Nothing here yet. Open a session in a connected agent and this fills up: the session start, every prompt, the conversation as it is kept, and anything the memory set gains or loses.
- Empty (one filter): Nothing of this kind in the last few records. Try All.
- Footer: {n} records · newest first

## Errors

- Save failed: Could not save. Satchel didn't get a reply. Your draft is still here and nothing was written. / Try again
- Revision conflict: This {memory/task} changed while you were editing. {app} saved revision {n} at {time}. Your text was not saved and nothing was overwritten. / Show revision {n} · Keep my text as a new draft · Discard mine
- Sign-in failed: GitHub sign-in didn't finish. It was cancelled or timed out. Nothing was created. Try again, or check that pop-ups are allowed.
- Load failed: Couldn't reach your Satchel. {what} didn't load. Nothing is lost. Your apps keep whatever they already read. / Reload
- Blocked handoff or update without a reason: A blocked {handoff/update} needs a blocker.
- Instance not set up (existing): This instance is awaiting account setup. Sign-in will be available once it is connected.
