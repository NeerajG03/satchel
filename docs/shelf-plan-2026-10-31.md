# Shelf: capture, action items and profiles

31 October 2026 · plan, nothing built · not reviewed yet · decision 4 settled by Neeraj on 31 Oct, decision 3 settled by measurement and Neeraj on 2 Nov (keep today's model)

## The answer first

Press one key on the Mac or one button on the phone, dump anything (a thought, a screenshot, a voice note), and Satchel files it. It keeps what is worth remembering as memories, sends to-dos to Google Tasks, sends anything with a time to Google Calendar, and does all of it in the right profile: work or personal.

```
  Mac hotkey / phone tile / share
            │  text · image · voice
            ▼
     ┌─────────────┐   read it: transcript, description, text in the image
     │   Shelf     │──────────────────────────────────────────────┐
     └─────────────┘                                              ▼
                                         ┌──────────────── capture pass ────────────────┐
                                         │ which profile? (work / personal)             │
                                         │ looks at: today's calendar, open tasks,      │
                                         │ topics, memories already in that profile     │
                                         └──────┬──────────────┬──────────────┬─────────┘
                                                ▼              ▼              ▼
                                           memory         Google Tasks   Google Calendar
                                       (as today)      (to-do, date)   (has a time)
```

## What already exists, and what is missing

| Product | Good at | Missing |
|---|---|---|
| Nothing Essential Space | One physical key, voice and screenshots, finds events | Nothing phones only, no Google Calendar or Tasks, no Mac |
| Google Keep + Gemini | Reminders land in Google Tasks | One Google account at a time, no work vs personal |
| Tana | Voice memo becomes tagged action items | Calendar works for one account, one way |
| Saner.ai | Plain words become scheduled tasks, several calendars | No instant capture, no profiles |
| Raycast / Fabric | Global hotkey capture on the Mac | No task extraction, no phone |
| Granola / Notion AI | Action items from meetings | Meetings only |
| Rewind / Limitless | Recorded everything | Shut down after Meta bought them (Dec 2025) |

Nobody does all three of: **capture on any phone and a Mac**, **push to the real calendar and to-do app**, and **route to work or personal on its own**. That gap is the feature. Satchel already has the hard part nobody else has, the memory and consolidation pass that knows what you have said before.

## Decisions this plan needs from you

| # | Question | My pick | Why |
|---|---|---|---|
| 1 | Satchel decided on 20 Oct to have no tasks (D52). Does this undo that? | **No.** Satchel never stores a task. It writes to Google Tasks and keeps only the link | D52's reason was "a second task system splits attention". Writing into the real one keeps that true |
| 2 | Is a capture a memory? | **No.** A capture is a raw item in the Shelf. The pass decides what, if anything, becomes a memory, task or event | Keeps "a memory is one sentence the person said" true. A screenshot of a receipt is not a preference |
| 3 | Store images and voice as vectors? | **Measured 2 Nov: not needed.** Describe each capture, keep the file, embed the description with today's model. It found photos and voice notes as well as the multimodal model and stayed quiet more often (bake-off below) | Asked for on 31 Oct so a photo is findable as a photo. The test shows the description already does that |
| 4 | Ask before writing to my calendar? | **Yes, always for now.** A "here is what I pulled out" card, one tap to accept. Auto-write per profile is a later option, not a goal | Decided 31 Oct. Fast voice and photo capture is useful on its own even before anything is written out |
| 5 | Chat apps (Slack, WhatsApp)? | **Not now.** Later, only "forward this message to Satchel", never reading everything | Noisy, private, and work Slack needs an admin. Forwarding gives the useful part with none of that |
| 6 | Mac or Android first? | **Android share + tile first**, then the Mac menu bar app | A phone is where things happen away from the desk. Share target is the cheapest way to prove the loop |

## Profiles

A profile is **who you are being**: work or personal. It sits above topics.

| | Work | Personal |
|---|---|---|
| Google account | neeraj@company | personal Gmail |
| Topics | CBX, … | Satchel, reimbursements, home, … |
| Where to-dos go | Work Google Tasks list | Personal Google Tasks list |
| Where events go | Work calendar | Personal calendar |

Rules:
- Every topic belongs to one profile. A capture is routed to a profile first, then a topic.
- "About me" memories (how I like answers written, no AI co-author) stay shared across both. A memory can be marked profile-only.
- An agent session picks its profile from the topic or repository it is in, as it picks a topic today.
- Routing uses what the pass already sees: the words, the time of day, today's meetings in each calendar, and the topics in each profile. When unsure, it asks on the card instead of guessing.

## How it works

### 1. Capture
One endpoint takes text, an image or audio, plus where it came from and an optional profile hint. The file goes to storage (owner-only, like memories), and the Shelf row records when, from which device, and its status. Captures work offline: the apps queue and send later.

### 2. Read it
Two things happen to every capture:
- **Embed the capture itself** (image, audio or text) with the multimodal model, so "the whiteboard photo from Tuesday" finds the photo.
- **Make text from it**: a transcript for voice, a description and the visible text for an image. The pass reads this text to find memories, to-dos and events.

The original stays so you can open it.

### The embedding bake-off (first piece of work)

Memories and Shelf items must share one vector space, so moving to multimodal means re-embedding every memory. Both candidates can give 768 numbers per item, which is what the database stores today, so no column changes.

| | gemini-embedding-2 | EmbeddingGemma 2 (open) |
|---|---|---|
| Reads | text, image, audio, video, PDF | text, image, audio, video |
| Where it runs | Google's API | anywhere: our own box, or on the phone and Mac later |
| Cost | about $0.20 per million text tokens, $0.45 image, $6.50 audio | free model, we pay for the machine |
| Size we would use | 768 (cut down from 3,072) | 768 (its full size) |
| Watch out | audio is expensive | needs a server, since Vercel cannot run it; quality drops at small sizes |

How we pick:
1. Re-embed the 473-memory eval set with each and run the retrieval eval against today's model. The similarity gate is per model, so each gets its own measured gate.
2. Add 50 real captures (photos, voice notes, screenshots) with labelled searches, and score both on those.
3. Pick the one that does not lose on memories and wins on captures. If they tie, the open model, because it can later run on the device.
4. Re-embed all live memories once, then switch.

**Step 1 result, 2 Nov** (473 memories, 159 searches, each model with its own measured gate):

| Model | Score | vs today | Finds the right memory (of 114) | Stays quiet when nothing fits (of 45) |
|---|---|---|---|---|
| gemini-embedding-001 (today) | 0.640 | | 101 | 39 |
| gemini-embedding-2 | 0.651 | same (+0.012, inside noise) | 98 | 41 |
| EmbeddingGemma 2, with its prefixes | 0.560 | worse (-0.080) | 107 | 26 |
| EmbeddingGemma 2, no prefixes | 0.515 | worse (-0.125) | 104 | 22 |

Gemini 2 passes the "does not lose on memories" bar, at gate 0.73. With Google's search hint written into the text (`task: search result | query:` and `title: none | text:`, which its docs require because it takes no task type) it scores 0.649, still a tie.

**Step 2 result, 2 Nov** (50 openly licensed photos from Wikimedia Commons, 15 spoken voice notes made on the Mac, 130 searches and 20 searches with no answer, written blind by a helper who looked at each item; ranked among the 473 memories):

| Route | Right item first | In top 3 | Stays quiet when nothing fits (of 20) |
|---|---|---|---|
| Gemini 2, no hint, any route | 36% to 58% | 50% to 66% | 0 |
| Gemini 2 + hint, the file itself | 96% | 100% | 3 |
| Gemini 2 + hint, file and its description | 98% | 100% | 5 |
| Gemini 2 + hint, description only | 96% | 100% | 4 |
| **Today's model, description only** | **98%** | **100%** | **13** |

What it says:
- Without the hint Gemini 2 is broken for this. With it, every route finds the right item.
- Embedding the photo or voice itself is no better than embedding a description of it, on searches people type.
- Today's model on the description stays quiet far more often when nothing fits, which is what keeps noise out.
- So the switch is not needed for the Shelf. Make a description of every capture, keep the file, and embed the description with today's model. Re-test if the Shelf grows a "find photos like this one" search, which only the multimodal model can do.
- Limits: a small set (65 items, 20 no-answer searches); stock photos, not real dumps; machine voices. Every route scores near the top on finding, so the set is easy, and the difference that shows is the quiet one. The open model finds answers about as well but cannot tell "nothing fits" apart, so it would push noise into sessions. The prefixes used are the first EmbeddingGemma's; v2's own were not published on the pages checked.

### 3. The capture pass
A sibling of the consolidation pass, with the same guardrails: every output carries the words it came from, and nothing is invented. Shown the capture text, the profile's topics and memories, **today's and tomorrow's calendar**, and **open tasks**, it decides any of:

| Output | Goes to | Example |
|---|---|---|
| memory | Satchel, through the same add/extend/replace path as today | "Priya owns the pricing deck now" |
| to-do | Google Tasks (date only, the API drops times) | "send the deck to Priya by Friday" |
| event or timed reminder | Google Calendar | "dentist Tuesday 3pm" |
| done | marks an open Google task complete | "sent the deck" |
| nothing | stays on the Shelf, searchable | a meme |

### 4. Calendar and tasks as context
Not only places to write. Knowing today's meetings lets the pass attach "notes from the 3pm" to the right meeting and topic, and lets an agent session start with "you have a design review at 4". Calendar sends change pings (renewed on a schedule). Tasks has no pings, so it is checked every few minutes.

### 5. Where you capture

| Surface | Android | Mac |
|---|---|---|
| Fastest | Quick settings tile; Samsung side key can open the app; Android 14 notes role for the lock screen | Global hotkey opens a small floating box (no permission needed) |
| Screenshot | Share the screenshot to Satchel (Android asks each time if an app takes one itself) | Hotkey runs the built-in area screenshot (avoids the screen recording permission) |
| Voice | Hold the tile or widget to record | Hold the hotkey to record |
| From any app | Share sheet | Share menu and drag onto the menu bar icon |
| Gemini on the phone | App action "save to Satchel" (already a goal) | — |

Nothing's own Essential Key cannot be pointed at another app, so on a Nothing phone the tile and share sheet are the way in.

## Build order

| Step | What you get | Proves |
|---|---|---|
| 1 | Embedding bake-off. Done 2 Nov: keep today's model, describe each capture | Photos and voice are searchable through their description |
| 2 | Shelf and capture endpoint; text, image, voice from the web app | Dump and find works end to end |
| 3 | Android app: share target, tile, widget, offline queue | Capture in under 2 seconds from anywhere on the phone |
| 4 | Mac menu bar app: hotkey, area screenshot, voice | Same on the desk |
| 5 | Profiles in the database and the web app; topics assigned to one | Routing has something to route to |
| 6 | Shelf pass writing memories, plus an eval of 40 real captures labelled blind | It reads dumps correctly before it touches a calendar |
| 7 | Google sign-in per profile (one per account); calendar and tasks read as context | Two accounts work; work admin does not block it |
| 8 | Pass suggests to-dos and events on the confirm card | The action item part, always asked first |

Fast capture comes first because it is useful on its own: steps 1 to 4 already give a place to dump and find things, before anything is sorted or sent out.

## How we know it works

| Measure | Bar |
|---|---|
| Captures routed to the right profile | ≥ 95% (a wrong one is a work task on the personal list) |
| To-dos and events accepted unchanged on the card | ≥ 90% |
| A photo or voice note found by a plain search for it | in the top 3, ≥ 80% |
| Things invented (a task or event not in the capture) | 0 |
| Time from key press to "saved" | under 2 seconds, even offline |

## Limits and risks

- **Google verification.** Calendar and Tasks access are "sensitive". For one person, testing mode works but sign-in expires every 7 days. Wider use needs Google's review.
- **Work account admins** can block outside apps. Then the work profile falls back to "to-dos stay on the card, copy them yourself".
- **Tasks drops times when another app writes them.** The Google Tasks app lets you set a time, but its API (the way other apps write tasks) keeps only the date and cannot read or write the time. So anything with a time becomes a calendar event, and the time also goes in the task's notes if it is filed as a to-do.
- **Storage cost.** Voice and images are far bigger than sentences. Keep originals 90 days by default, text forever.
- **Privacy.** A screenshot can hold someone else's data. Captures are owner-only, never shown to connected agents unless the profile grant allows it, and use the same row-level security tests as memories.
- **Scope change.** Satchel's product doc says "no automatic transcript extraction" and "memory across AI apps". This plan widens it to "your shelf for everything, where you organise your life". Worth saying out loud in the decisions log before building.

## Steps 5 to 8: how they are built (4 Nov)

| Piece | Design |
|---|---|
| Profiles | Two fixed kinds per person, `work` and `personal`, in `profiles` (with the person's timezone). A topic is tagged in `topic_profiles`; a Shelf item carries `profile`. Null means not sorted yet |
| Sorting a capture | After the description, one more model call (`satchel-shelf-sort`) returns the profile, the topic, the words spoken (voice only), and to-dos and events. Every suggestion carries the words it came from, and the server drops any whose words are not in the capture |
| Memories | The person's own words (their note, or the voice transcript) become a one-turn conversation record (`shelf-<item id>`), so the consolidation pass stays the one writer. A photo's description is Satchel's words and never becomes a memory |
| The card | `shelf_suggestions`: pending, added or dismissed. Nothing reaches Google until the person taps Add |
| Google per profile | Linked from Settings with Google's own consent screen. The refresh token is encrypted with a server-only key (`SATCHEL_GOOGLE_TOKEN_KEY`) before it is stored, so no browser, app or database reader can use it. The sort call is shown the next 7 days of calendar events and open tasks as context |
| Adding | A to-do goes to Google Tasks with its date (the time, if any, in its notes); an event with a time goes to Google Calendar; a date-only event becomes an all-day event |

Three PRs, each tested, reviewed, migrated and checked live: profiles; sorting and the card; Google.
