# Copy deck

17 September 2026. Every string a developer needs, by page. Plain words. Address the user. Say source and destination. No slogans inside working screens. Dates and names in examples are sample data.

## Shell

| Where | Text |
|---|---|
| Wordmark | satchel |
| Rail | Left off · Book · Topics · Apps · Settings (plus Activity in developer mode) |
| Rail write key | Write |
| Header status (word next to the light) | Synced · Nothing saved yet · No apps connected · Topic has nothing yet |
| Footer right, default | Explicit saves only |
| Footer left, examples | 5 in the book · 3 topics · 2 apps |

## Welcome (signed out)

- Eyebrow: Your work, with you
- H1: A place for what you want to remember.
- Body: Keep the decisions, preferences and next steps that make your work yours. Write them once. Every connected AI app can read them.
- Button: Continue with Google / Opening sign-in…
- Second button: Use GitHub instead (for accounts made with GitHub before Google sign-in; a Google account with the same email opens the same account)
- Under buttons: Your account is only used to sign you in. Satchel asks for nothing else here.
- Side list: The book / Preferences and decisions you chose to save. Names and short descriptions form an index agents read first. · Topics / One subject, its repositories and the apps allowed to see it. · Apps / Each connected agent gets only the scopes you grant. Revoke any time.
- Footer: Satchel · Private pilot — A little less repeating yourself

## Left off, first run

- H1: Welcome, {first name}.
- Lede: Your Satchel is empty, which is the right place to start. Do any one of these three and this page turns into "Where you left off".
- Step 1: 01 · Two minutes / Write the first thing down / A preference about how you like to work. It applies everywhere, no topic needed. / Open the book
- Step 2: 02 · Five minutes / Connect an AI app / Install the Satchel plugin in Claude Code or Codex, then sign in from its connection settings. You choose what it can read. / See the steps
- Step 3: 03 · When you have one / Start a topic / A name and a line about the subject. Memories about it gather there. / Open topics
- Notice when topics exist but are empty: You have {n} topics but nothing in them yet. {names} were created earlier. A topic with no memories is invisible to agents until you add something. / View topics

## Left off

- H1: Where you left off.
- Actions: Open the book · Write something down
- Main, when something is new since you last opened the book: Since you last looked · {n} topics / {n} new memories in {k} topics. / Row: {topic} · {n} new, links to that topic's book / See what came in
- Main, otherwise: Last thing saved / "{statement}" / {name} · {scope} · revision {n} · {when} / Open the book
- Footer: {n} in the book · {n} topics · {n} apps
- Aside: Your apps / reads and saves · verified today / reads only · last read Fri / not connected / Manage apps

## Book

- Eyebrow: For me · Topic · {name}
- H1: The book.
- Lede, For me: "For me" holds preferences and details that apply across all your work. Pick a topic from the picker when something belongs to one subject only.
- Lede, topic: {brief} · Decisions and details for this topic only.
- Picker button: In {scope}
- Picker: Find a topic · For me / applies everywhere · Topics · {n} · {name} / {n} memories · empty · New topic
- Picker locked: Finish or discard the correction to switch scope. / Save or discard the draft to switch scope.
- Segments: All {n} · Saved by me {n} · Saved by agents {n}
- Composer: Write something down · saving in {scope} / Name · short, how an agent will find it / Description · one or two lines. This is what agents read first / Add more info (optional) / Name and description form the index. More info is read on demand. / Discard · Save memory
- Correcting: Correcting · will save as revision {n} / Revision {n-1} stays in history / Discard changes · Save correction
- Entry actions: Correct · Read more info · Hide more info · {n} revisions
- Provenance: Said on your {device} · {when} · revision {n} / Saved by {app} · {device} · {when} · revision {n}
- Forget confirm: Forget this memory? It stops loading right away and waits in the archive, so you can bring it back. Copies in earlier chats and {app}'s own memory are not touched. Satchel can't reach those. / Keep it · Forget
- Forget footer: Forgotten · it is in the archive if you want it back
- Below the list: Anything forgotten, replaced or finished waits in the archive.
- Composer kind: What kind of thing is this · How things are (true until something makes it false) · How you like things (gets stronger each time you say it) · Something you want (ends when it is done)
- Entry provenance: handle {name} · {kind} · said {n} times · picked up automatically · revision {n}
- Entry actions: Correct · Read more info (only when there is any) · See what you said (picked-up memories) · Hide
- Row tags (last week only): New · Said again · Changed
- Day groups: Today · Yesterday · Last 7 days · Before that / {n} new · {n} said again · {n} changed / {n} memories
- Since note, every topic, in every scope: {n} new memories since you last looked, in {k} topics. (or: Nothing new since you last looked.) / You were last here {when} / Topic row: {topic} · {n} · new · {n} said again · {n} changed · {n} archived / Show all {n} for {topic} · Open its book (Open For me)
- Below the groups: Show all {n}
- Source block heading: From what you said
- No approval action anywhere. A memory is a memory whether or not the person agrees with it, and asking them to confirm one turns memory into a queue of chores.
- Empty: Ideas for a first memory / Start with something about you. / Things you end up repeating in every new chat make good first entries. Tap one to prefill the form above. / How I like answers written · Tools and languages I use · What to never do in my code · My working hours and timezone
- Search: Searching names, descriptions and more info in this scope. Search all scopes instead / Matches {n} · In name {n} · In more info {n} / matched in name and description / Not here? Memories saved in "For me" and other topics are not searched unless you widen the scope above. / Clear
- Footer: {n} in the book · {scope} / {n} of {total} match "{q}" / Saved to your book · revision {n} / Forgotten

## Topics

The route is `/topics` (`/topics/new`, `/topics/{id}`, `/topics/{id}/delete`). Old `/projects` links redirect to the matching `/topics` path.

- H1: Topics.
- Lede: A topic is a subject your memories are about. Satchel makes one when a work fact fits none of these. You can also link a codebase to it.
- Button: + New topic
- Columns: Topic · Memories · Apps with access · Last activity
- Mark on a topic Satchel made: made by Satchel
- Merged section: Merged / kept so you can undo / {name} went into {other} / Undo merge
- Announce after undo: Merge undone · {name} is back
- Empty: No topics yet. / "For me" already holds everything that applies everywhere. Satchel makes a topic when a work fact needs one, or you can make one now.
- Topic page eyebrow: Topic · Topic · made by Satchel
- Topic page, merged: Merged into {other}. / Its memories moved there. Undo it from the topics list to put them back.
- Row: No repositories linked · Nothing saved here yet.
- New topic sheet: New topic / Name the effort, not the repo. / A topic can hold many repositories or none. You can link codebases on the next page. / Name / Brief · one or two lines an agent reads to tell this apart from your other topics / A topic with this name already exists. Create a second one anyway? Agents pick topics by name, so two with the same name can confuse them. / Opens the new topic page / Cancel · Create topic · Create anyway
- Topic page: ← Topics / Delete topic (torn page key) / Open its book / Edit brief / Linked codebases · Link another · Unlink / A linked repository lets an agent pick this topic for a coding chat. It does not grant access by itself. / Apps that can see this topic · Manage / Activity / Memories · {n} · Open the book
- Empty topic: Agents can't see this topic yet. It has no brief and no memories. Fill in the brief first so an agent can tell it apart from "{other}". / Brief · one or two lines an agent reads to know what this effort is / What is this topic for, and what does "done" look like? / Save brief / You can change it any time. / Codebases / Link a repository / Optional. Lets a coding agent select this topic when it opens that repo. / Book / Save a first decision / Something agents should know before working here. / Write in this topic's book
- Topic not found: That topic is not here. / It may have been removed. Nothing else changed. · This topic (load error)
- Delete topic (`/topics/{id}/delete`): ← Back to topic / Delete topic · this cannot be undone / Topic / Delete "{name}"? / Everything in it goes too: {n} memories in its book · {n} linked repositories. Agents opening those repos will no longer land here. · No app can see this topic. / {n} connected apps lose access to it: {names}. Their other grants stay. / Type the topic name to confirm / Keep the topic · Delete this topic / This topic changed while you were looking. / Footer: Delete topic · {name}

## Apps

- H1: Apps.
- Lede: Each app gets only the scopes you chose. A permission here applies to every installation using that app identity.
- Empty: Nothing is connected yet. An app gets only the memory scopes you grant when it first asks. You can revoke later. / 01 · In your terminal / Install the Satchel plugin / Both apps install from the same public catalog. Pick yours. / Claude Code · Codex / {install commands} · Copy / Or let {app} do it. Copy a prompt, paste it into a {app} chat, and it runs the install for you. / Copy prompt for {app} / 02 · In the app / Sign in / The login command opens Satchel in your browser with a consent page. Nothing is granted until you allow it. / {login command} · Copy / 03 · Back here / See it connected / The app appears in this list with a green light once you allow it. / Waiting for the first connection
- Empty footer panel: What a connected app can never do: read scopes you didn't grant, save without both write permission and your explicit ask, or see More info in bulk. Hooks read names and descriptions only.
- Card: Verified · read {when} / Connected · last read {when} · no writes granted / Revoked {when} · earlier retrieved content stays in that app / Memory / read and save · read only · none / Revoke access · Edit scopes · Reconnect from the app
- Grant line: For me · Every topic, including new ones · {name} · a removed topic
- Footer: {n} apps connected · {n} revoked / {app} access revoked — Earlier reads stay in that app

## Consent

- Eyebrow: An app wants to connect
- H1: {app} wants to read your Satchel.
- Under: Name supplied by the app · will return to {redirect}
- Quick start: Read everything · Read and save everything · Clear all
- Groups: Memory / Scopes it can read · every topic and you · you only · nothing / Everything · None / For me · personal memories / Every topic · all {n}, and the ones made later / Also allow saves, corrections and forgets / Only when you ask it to, in that chat.
- Shelf group: Your Shelf · allowed / nothing / Search your Shelf, read its lists and add notes · Work and Personal. Never photos or voice, never removes anything (needs a memory scope first). Aside: The Shelf is what you drop from your phone and the web. With it, the app can find “that receipt” or your Books list, and put a note on the Shelf when you ask. Satchel then sorts that note like any drop. Summary: Shelf: search, lists and add notes / nothing
- Apps card: Shelf · Search, lists and add notes · Work and Personal / Not allowed. On a Shelf card: from {app}
- Note: Topics are all or none. "Every topic" keeps being true, so a topic made next month, by you or by Satchel, is included without asking again.
- Actions: Allow this access · Deny · You can change or revoke this later in Apps.
- Aside: What this means / Reading means the app's hooks get the names and descriptions of memories in these scopes. It fetches More info by name only when it needs it. / Writing still needs your explicit ask inside the chat. The app cannot save on its own. / Summary
- Footer: Deny closes this and sends the app back

## Connected (Satchel × partner)

- Left: Connected / {app} can now read your Satchel. / Only the scopes you just allowed. Change or revoke them any time in Apps. / Back to Apps
- Right: Connection complete / Satchel is connected to {app}. / Sending you back so it can finish signing in. Your next conversation starts with your memory index already loaded. / Return to {app} now

## Settings

- H1: Settings.
- Account: {handle} · {email} / Sign out / Your Google or GitHub account is used only to sign you in.
- Developer mode: Adds an Activity page showing every request that came in, every conversation Satchel kept, and every change to a memory, and lets you run the consolidation pass by hand. It is a view and one button, not a permission: nothing about what is stored or who may read it changes. / Show Activity in the rail · this browser only / Open Activity
- Overnight pass: While you are away, Satchel reads the conversations that have gone quiet and updates your memory from them. It signs in as its own connection, listed in Apps as Satchel consolidation, and you can revoke it there. It is off until you switch it on. / Run overnight / How often: Once a day · Twice a day / Run at · First run · Second run / On these days: Sun to Sat · Every day · Weekdays / Times are in {zone}, this browser's time zone. A pass only runs when there is a conversation that has been quiet for 30 minutes, so a night with nothing new costs nothing. / Save schedule
- Overnight pass, problems: Choose at least one day of the week. · Choose one time, or two at most. · Two passes need to be at least an hour apart. · That time zone is not recognised. · Switch the overnight pass on first.
- Overnight pass, state: Switched off after three refusals in a row. Switch it on again to sign it in fresh, or delete what is stored. / Delete the stored sign-in / The stored sign-in was deleted / Off. The stored sign-in is deleted. The connection stays listed in Apps until you revoke it there. / Switched on, but the timer that runs it is not installed on this database. / Lights: working · not run yet · {n} refused · not installed / last run · next run
- Overnight pass, switching on (`/settings/consolidation`): H1 Switching on the overnight pass. / You did not allow it, so the overnight pass was not switched on. · That sign-in has expired. Switch the overnight pass on again. · That response did not match this request, so nothing was switched on. Try again. · Satchel could not set up the overnight sign-in. Nothing was switched on. Try again in a minute. · Satchel could not finish signing the overnight pass in. Nothing was switched on. Try again. · The overnight pass can only be switched on from the hosted Satchel, over https. Open it there. · This browser would not let Satchel remember the sign-in between pages. Allow site data for this page and try again. / Back to Settings
- Overnight pass, on the consent page: What the overnight pass needs (button) / The overnight pass (aside): This is the connection you just asked for in Settings. It reads conversations that have gone quiet and saves what it learns, so it needs your memory, every topic and you, with saves. Nothing is ticked for you: press the button above or choose your own.
- Footer: Overnight pass is on · {schedule} · Overnight schedule saved · {schedule} · Overnight pass is off · the stored sign-in was deleted
- Forgetting: Forget removes a record from active retrieval right away. Satchel cannot delete copies from earlier chats or an app's own memory. / Read how retention works

## The book · archive

- Eyebrow: The book · archive
- H1: Not loading any more.
- Lede: Memories you forgot, ones replaced by something newer, and things you wanted that are now done. Nothing here reaches an agent. Everything here can come back.
- Why it is here: You forgot it · Replaced by a newer one · Done, so it was retired · Its date passed
- Actions: Put it back · Delete for good · Reload
- Delete for good: Unlike forgetting, this really destroys it. The memory and its whole history go, and nothing can bring them back. / Keep it · Delete for good
- Empty: Nothing has been put aside. When you forget a memory, or Satchel replaces one with something newer, or something you wanted gets done, it waits here instead of disappearing.
- Footer: {n} archived · Back in your book · Deleted for good — its history went with it

## Shelf

- Rail: Shelf
- Eyebrow: Shelf
- H1: Your Shelf
- Lede: Everything you dropped, sorted by topic, beside what needs you and your week ahead. Only you can see your Shelf.
- Bar: Profile (All · Work · Personal, with counts) · Find · Drop something / Close (the drop form opens on its own when the Shelf is empty)
- Sections: one per topic, the biggest first, then Not in a topic yet · {n} things
- Type: Everything · Photos · Voice notes · Notes, with counts
- Nothing in view: Nothing here. Nothing on your Shelf fits this profile and type. Pick Everything or All to see the rest.
- Drop: Note (optional with a photo or voice note) · Add a photo or audio file · Record a voice note (with a photo chosen: Say what this photo is; saved as one item, "{file} with your voice note") · Stop recording · Recording… · Voice note recorded · remove · Photos and voice notes up to 20 MB. · Put on Shelf · Saving…
- Find: Find something (describe it the way you remember it) · Find · Looking… · Show everything · {n} matches, closest first.
- Item: note · photo · voice note · reading it… · not read yet · could not read this one · Try reading it again · Look for to-dos · Edit note / Add a note (Save note · Cancel · Note changed) · Remove
- A voice note shows what was said, in quotes, instead of Satchel's summary
- After Look for to-dos: Found {n} things to do · Nothing to do in this one
- Remove: Remove this from your Shelf? It goes for good, with its file. Nothing can bring it back. / Keep it · Remove for good
- Empty: Your Shelf is empty. Put a note, a photo or a voice note on it above. It is read in a few seconds and sorted into a topic.
- No match: Nothing on your Shelf fits that. Try other words, the way you would describe it to someone.
- Footer: {n} things on your Shelf · On your Shelf · Read and on your Shelf · Removed from your Shelf
- Errors: Satchel could not use the microphone. Allow it for this site, then try again. · The Shelf takes photos (JPEG, PNG, WebP, HEIC) and voice notes (WebM, M4A, MP3, WAV, OGG). · That file is over 20 MB, so nothing was saved. Try a smaller one. · The file did not upload, so nothing was saved. Try again. · Satchel could not read this one, so it is saved but not searchable. Try dropping it again. · Search is busy right now. Try again in a minute.

## Settings · Profiles

- H2: Profiles
- Lede: Work and Personal. Each topic belongs to one, and so does everything on your Shelf, so a to-do lands in the right calendar and list.
- Per topic: Not set · Work · Personal
- Empty: You have no topics yet. New ones can be tagged here.
- Footer: Moved to Work · Moved to Personal · Taken out of both profiles
- Error: Could not change the profile.
- Timezone: Times in your captures are read in {zone}. · Use {browser zone} instead
- Shelf item picker: No profile · Work · Personal

## Shelf · Lists

- A block per list, named by Satchel as drops call for it (Books, Watch, Recipes to try), biggest first, on one board with the drops that did not become lines (each card shows its topic): {name} · {n} to go · {n} done · All done. · Show all {n} / Show fewer · Done · {n} / Hide done
- Line: a tick, the title, and the detail (author, year, city) under it. Tapping the title shows: from “what the drop said” · On {List} / Move to {List} · Remove
- Done fold: Done · {n}; a ticked title is struck through
- On a drop that made lines: Added to {List} ({n}), {List} ({n}) · Undo → Taken off your lists
- Footer: Done: {title} · Back on {List}: {title} · Moved to {List} · Removed {title}
- View switch: As dropped / Rearranged (As dropped shows every drop by date, lists folded away)

## Shelf · Expenses and Good to know

- Expenses block: Expenses · {n} to claim · {n} claimed / line: shop, then amount (₹2,340.00, $23.40, or amount? when none was printed) · day · Work / tick = Claimed / All claimed. / ⋯ on the block: Copy Work expenses for a claim → Work expenses copied, one per line
- Good to know block: Good to know · {n} / line: a copy key (aria: Copy {label}), LABEL over the value → Copied {label} / This browser would not copy. Select the text instead.
- Neither moves to another list; a book never moves onto them.

## Shelf · Coming up

- H2: Coming up · Next 7 days
- Row: when (Thu 10:00, or Thu, Nov 5 for an all-day event), Task · before an open task, the title (links to the calendar or list), the profile when All is picked
- Not linked: Pick a Google calendar or to-do list for {Work or Personal} to see your week here. Settings
- Empty: Nothing on your calendar or tasks in the next seven days.
- One account did not answer: A calendar or list for {Profile} did not answer, so it is not shown. Reload to try again.
- Server not set up: Connections are not set up on this server yet, so your week cannot be shown here.

## Shelf · Waiting for you

- H2: Waiting for you
- Lede: Found in what you dropped. Nothing is added anywhere until you say so.
- Nothing waiting: Nothing waiting. To-dos and events Satchel finds show up here.
- Follows the profile picked above; one with no profile yet shows under both.
- Row: To-do · Event, then the profile and when ("by Fri, Nov 6" for a to-do, "Thu, Nov 5, 4:00 PM" for an event), the title, and from “the words it came from”
- Actions: Add to {place} (the slot set for that profile) · Dismiss
- Footer: Dismissed
- Error: Could not change this.

## Settings · Where things go

- H2: Where things go
- Lede: Each profile has a to-do list and a calendar. Pick where each one lives: Google Tasks, Google Calendar or a Notion database. Nothing is added until you say yes on the Shelf.
- Accounts: {Google|Notion} · {email or workspace} · Disconnect (Disconnecting…) · No accounts connected yet. · Connect Google (Opening Google…) · Connect Notion (Opening Notion…)
- Slots: {Personal|Work} · {To-dos|Calendar}, a picker: Nowhere yet · Google Tasks · {email} · Google Calendar · {email} · Notion · {workspace}. Google Tasks is offered for To-dos only.
- A Notion slot: Files into {database} · Edit columns
- Notion setup: Database (Pick one) · Each new page gets the title in {title column}, and what you dropped in its body. Set the rest once: · Day: Don’t fill a date / Put the day in {column} · a choice column: Leave empty / {its choices} · a person column: Leave empty / Me · a tick column: Leave as Notion sets it / Ticked / Not ticked · a many-choice column: tick any; over 12 choices, Find one of {n} · Save (Saving…) · Cancel
- Notion shared nothing: Notion shared no databases with Satchel. Connect Notion again and tick the database on Notion’s screen.
- Error heading: Nothing was changed. · That slot was not changed.
- Fine print: Connecting lets Satchel add what you say yes to, and read the next week of a Google calendar and to-do list so it can place what you drop. On Notion it sees only the pages and databases you pick on Notion’s screen.
- Footer: {Google} is connected: {label}. Now pick where things go. · {Work} {To-dos} go to {place} · {Work} {To-dos} go nowhere for now · {Google} {label} is disconnected
- Return page: Connecting {Google|Notion}… · Nothing was connected. · Back to Settings
- Errors: You said no on {provider}’s screen, so nothing was connected. · This did not start in this tab, so it was not used. Start again from Settings. · Google did not give Satchel the calendar and to-do permissions. Connect again and leave every box ticked. · {Provider} is not set up on this server yet, so nothing was connected. · Notion would not show that database. Share it with Satchel in Notion, then try again. · That database has no title column, so Satchel cannot file anything in it.

## Shelf · Waiting for you · Add

- Buttons: Add to {place: Google Tasks, Google Calendar or the Notion database's name} · Adding… · Set {Work} {To-dos|Calendar} (when that slot goes nowhere) · Which profile? (when Satchel could not place it)
- Footer: Added to {Work} {place}
- Errors: Pick where {Work To-dos} go in Settings first. · The account behind {Work To-dos} no longer accepts Satchel. Connect it again in Settings. · It was not taken this time, so nothing was added. Try again. · A calendar needs a day. Add this one somewhere else, or dismiss it.

## Activity (developer mode)

- Eyebrow: Developer
- H1: What Satchel did.
- Lede: Every request that came in, every conversation kept, and every change to a memory, in the order it happened. Yours alone.
- A moved memory, opened: Move back to {topic or personal} · Moving… / Puts it where it was before this move. / Moved back to {topic}. / Refusals: It has moved since, and is in {topic} now. Nothing changed. · That memory is not live any more, so there is nothing to move back. · The topic {slug} is gone, so it cannot go back there.
- A conversation, opened: The conversation · {n} agent steps / You · Agent / What the agent did · {n} steps / Ran · Edited · Read · Searched · Used / Show all {n}
- Filters: All · Requests · Documents · Memory
- Row kinds: Session start · Prompt · Capture · Consolidation · Document · Memory
- Row actions: Look / Hide · Reload · Consolidate now
- Consolidating: Reading…
- Ran, nothing ready: Consolidation ran. Nothing was ready. A session counts as finished after 30 quiet minutes.
- Ran, nothing changed: Consolidation ran. Read {n} conversations and changed nothing, which is the usual answer.
- Ran, changed something: Consolidation ran. Read {n} conversations · {n} added, {n} extended, {n} retired
- Failed: Consolidation did not run. {reason}
- No model configured: No consolidation model is configured for this deployment.
- Detail headings: What was typed · Sent · Returned · Before · After · The conversation
- Empty (All): Nothing here yet. Open a session in a connected agent and this fills up: the session start, every prompt, the conversation as it is kept, and anything the memory set gains or loses.
- Empty (one filter): Nothing of this kind in the last few records. Try All.
- Footer: {n} records · newest first
- Overview panels: Waiting to be read · Models since the quota reset · Schedule · Memory set
- Waiting: {n} sessions ready · {n} still going / {slug} · {session} · {n} turns · never read (or: read before, has more) · quiet since {when} / And {n} older.
- Waiting note: The button reads a session once it has been quiet for 30 minutes. The rest wait for the next press.
- Waiting, empty: Nothing is waiting. Every kept conversation has been read.
- Waiting lights: {n} ready · nothing ready
- Models: {n} answered · {n} refused · last call {when} / No model calls since {time}. The last one was {model}, {when}, for a {capture/consolidation}(, and it failed).
- Model lights: answering · quota used · failing
- Models note: Counts what this deployment logged since {time}, when Gemini's free quota resets. Evals on the same key use the quota too and are not in here.
- Schedule, never set up: Nothing runs on its own. The button is the only way a pass starts.
- Schedule: {Every day|Weekdays|Mon, Wed} at {HH:MM and HH:MM} ({zone}), for sessions quiet for {n} minutes. · Switched off. Only the button runs a pass. · Switched off after three refusals in a row. · Switched on, but the timer that runs it is not installed on this database.
- Schedule lights: off · switched off · not installed · {n} refused · working · not run yet
- Memory set: {n} live · {n} picked up by Satchel / {n} preferences · {n} facts · {n} intents / No live memories yet.
- Overview failed: Could not load the overview / Reload
- Earlier passes: Earlier passes / Report · Hide / Could not read earlier passes.
- Feed heading: Everything, newest first

## Errors

- Save failed: Could not save. Satchel didn't get a reply. Your draft is still here and nothing was written. / Try again
- Revision conflict: This {memory/topic} changed while you were editing. {app} saved revision {n} at {time}. Your text was not saved and nothing was overwritten. / Show revision {n} · Keep my text as a new draft · Discard mine
- Sign-in failed: Sign-in didn't finish. It was cancelled or timed out. Nothing was created. Try again, or check that pop-ups are allowed.
- Load failed: Couldn't reach your Satchel. {what} didn't load. Nothing is lost. Your apps keep whatever they already read. / Reload
- Refusals from the database: one sentence per reason, kept in `src/errorText.mjs` (`reasonText`, keyed on the `satchel:<reason>` hint every raise carries; `raisedText`, `constraintText` and `raisedPatterns` for a database that sends no hint). `tests/web-error-text.test.mjs` fails when a routine raises without a hint, or with a reason that has no line there. Each says what failed, what is safe, and one thing to do, for example: This topic is already gone. It may have been deleted in another tab. Reload the topics list.
- Session gone (only when the auth client has no session, or the token is expired): Your sign-in has expired. Sign in again, then try once more. Nothing was changed.
- Session there, guard still refused: Satchel did not accept your sign-in for this, so nothing was changed. Reload the page and try again. If it keeps happening, report it.
- Request came as a connected app, not the person's sign-in (`satchel:app_token`): Only you can do this, from the Satchel web app, and this request did not come from your sign-in there. Nothing was changed. Reload the page and try again. If it keeps happening, report it.
- Session could not be checked: Satchel could not confirm it was you, so nothing was changed. Reload the page. If it asks you to sign in, do that, then try again.
- Refusal nobody listed: Satchel refused this, so nothing was changed. Reload the page and try again. If it keeps happening, report it.
- Error titles next to the button: Could not delete. · Could not revoke. · Could not undo the merge. · Could not change the archive. · Could not move it back. · Could not change the linked codebases. · Could not finish connecting. · Could not finish that.
- Load error with a known reason: {what} didn’t load. / {reason} / Reload
- Instance not set up (existing): This instance is awaiting account setup. Sign-in will be available once it is connected.
