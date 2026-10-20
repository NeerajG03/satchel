# Rules the agent ignores · 19 October 2026

**Status:** offline test run 20 Oct (section 8). The fix is rewording the rules; nothing built yet. **Decides:** Neeraj. **Follows:** [Following first](following-first-2026-10-18.md), sections 1, 4 and 8.

The last design said the first thing to try for following was this: show a rule again at the message where it applies. I measured it before building anything. **It would not have helped.** This doc says why, what the data points at instead, and how I'd test the next idea cheaply before building it.

---

## Words used here

| Word | Meaning |
|---|---|
| **start block** | The memories Satchel puts in front of the agent when a session begins, or again after a compact or a clear |
| **prompt block** | The up to 5 memories Satchel adds when you type a message, picked by how close they are to what you typed |
| **match score** | How close a memory is to what you typed, from 0 to 1. A memory needs 0.67 or more to be shown today (the gate) |
| **complaint** | A time you corrected the agent on a rule Satchel already had. The following score counts these (decision D50) |
| **re-show** | Showing a start-block rule again in a prompt block. Today that never happens (decision D28) |
| **`CLAUDE.md`** | Your own instructions file. Claude Code loads it at the very top of every session, above anything Satchel adds |

---

## 1. What I tested

```
 the idea:   start block ── ... many messages ... ──► message where the rule applies
                                                       └─ re-show the rule here
```

Three versions, run on the injection replay (179 sessions, 1,090 labelled messages, no paid calls):

| Version | How it works | Re-shown per 100 messages | Utility vs today (0.738) | Gate |
|---|---|---|---|---|
| A, gate 0.67 | A start-block rule may come back once if it matches at 0.67+ | 9.5 | 0.691 | fails |
| A, gate 0.72 | Same, at 0.72+ | 3.2 | 0.726 | fails |
| A, gate 0.77 | Same, at 0.77+ | 1.3 | 0.732 | fails |
| B, gate 0.72, every 10 | Same, but may come back again after 10 messages | 0.6 | 0.735 | passes, noise |
| C, every 10 | The 3 most-said rules again every 10 messages, no matter what | 8.7 | 0.713 | fails |

The replay can't give credit for a re-show. A start-block rule already counts as in front of the agent, so a re-show can only cost. So the real test is the next one.

## 2. Would it have reached the failures? No.

For each complaint, I took the 3 messages before you corrected the agent. Those are the ones the agent was answering when it went wrong. Then I asked: would any version above have re-shown the rule there?

```
 complaints that could be scored            10   (of 14; 2 not found, 2 were the first message)
 rule re-shown before the agent went wrong   0   under every version and gate
 best match score in those 3 messages        0.665  (gate is 0.67)
 typical match score of a style rule         0.55 to 0.66 against normal work messages
```

Version A did fire in 5 complaints, but always on the correction message itself. By then you had already said it.

## 3. What the data says the problem is

### The rule was close, not far away

```
 typed messages from the last start block to the complaint
 (9 complaints; left out: 1 where the rule did not exist yet, 2 on a session's first message)

  2 ▌▌    3 ▌    4 ▌    5 ▌▌    8 ▌▌▌          median 5
```

A compact, a clear or a resume brings the start block back. So in these 9 the rule was in front of the agent a few messages earlier. That is counted in typed messages, not in size: 5 messages with a lot of tool work can still be a big context.

### Putting the rule at the top has already been tried

```
 ~/.claude/CLAUDE.md   (top of every session, "you MUST follow them exactly")
   - plain 8th-grade words, no jargon ...          ◄─ same idea as 1db602
   - Neeraj is a visual learner ...                ◄─ part of bf351a
 Satchel start block
   1db602, bf351a ... (again)
```

Two of the rules you keep correcting are already in your `CLAUDE.md`, the strongest place a rule can sit in Claude Code. 7 of the 13 complaints were on those two. So a firm, always-on placement at the top did not stop the misses. I first leaned toward giving the rules their own "always" section at the top of the start block. That evidence says it would most likely do nothing.

### Many complaints are about something the rule doesn't say

Reading the complaints against the rule they were filed under:

| What you asked for, in short | Filed under | What that rule actually says |
|---|---|---|
| shorter, less wordy, fewer points (several times) | 1db602 | use plain words, no jargon |
| shorter, less wordy (several times) | bf351a | plan docs simple and visual, design first |
| answer in your short "adhd" format | bf351a | as above |
| clean up comments in a PR | 4fa6dd | comments only for the why |

**Length** comes up again and again, and no rule says "keep answers short". The one rule close to it, 9e0448 (answer first, lists of 5 or fewer), is stored as a **fact**, not a preference. So the agent may be following the rules as written while you are asking for something else. And some comment complaints may be about code written in an earlier session, before the rule could apply.

So I feel the first problem is the rule data, not where it sits. That costs nothing to fix.

---

## 4. Options

| | Fix the rule data (recommended first) | Test layouts offline before building | "Always" section and a line on every prompt | Re-show by match | A check before each reply goes out |
|---|---|---|---|---|---|
| What | Add "keep answers short" as its own rule, make 9e0448 a preference, make the long rules concrete and checkable | Rebuild the context of the real failing turns and have a model answer them with and without each change, then grade against the rule | Top section in the start block, plus one line on every prompt | Version A above | Code checks (reply length, comment count in a diff), or a model |
| Reaches the failures | Yes, it fixes what the agent is told | Tells us which change does | Unproven, and `CLAUDE.md` says probably not | No, 0 of 10 | Yes, at the moment of failure |
| Cost | Nothing. Your call on the wording | About 400 model calls. I'll price it exactly before running | About 25 tokens a prompt | Utility 0.738 to 0.726 | Code checks are free. A model costs a call per reply |
| Risk | None worth naming | A model answering a rebuilt turn is not the live agent | The same line on every prompt is easy to skip, and the scorecard can't see the cost | Shows rules where they don't help | Wrong flags annoy. A model check sends your replies to another model |

**My lean, in order:**

1. **Fix the rule data now.** It's free and it goes straight at what you keep asking for.
2. **Then run the offline test**, with today's layout, the fixed rules, the always section, and the always section plus the line. Each one runs on the 9 or 10 real failing turns, about 5 answers each, graded against the rule.
3. **Build only what wins that test.** If nothing beats the fixed rules, build nothing.

The 4-week following score is still the long-run number. But it can't judge this change on its own. With about 13 complaints in 4 weeks, and 7 of them on one day, even halving them is within noise. That's why the offline test comes first.

<details>
<summary>+ Other ideas the review raised, for later</summary>

- Remind at the moment of failure, not at the prompt. For the comments rule that would be when the agent edits a file (the hook before a tool runs, which Satchel already ships).
- Remove the overlap with `CLAUDE.md`, so the same rule isn't loaded twice in two wordings.
</details>

---

## 5. What I need from you

| # | Question | Yes means |
|---|---|---|
| 1 | Add a rule "keep answers short and to the point" (your words, I'll draft) | A new personal preference |
| 2 | Change 9e0448 from a fact to a preference | It counts as a rule and loads as one |
| 3 | Run the offline test, once I give you the exact cost | About 400 model calls, results in a day |

I won't write any memory without your yes on 1 and 2. Saving and correcting only happen when you ask.

---

## 6. Decided

| When | What |
|---|---|
| 19 Oct | Re-showing a rule by match is not built. Measured: 0 of 10 complaints reached |
| 19 Oct | No layout change ships without the offline test showing it helps |

## 7. What the review changed

An independent reviewer read the first draft against the raw results.

| Review said | Changed |
|---|---|
| Your `CLAUDE.md` already puts two of these rules at the top, and they still get broken | Section 3 says so. The always section is no longer the lean |
| The histogram counted a rule that didn't exist yet and two first-message complaints | Left out. The median is 5, not about 4 |
| Many complaints are about length, which no rule says | Fixing the rule data is now the first step |
| The 4-week score can't judge this; test offline instead | Offline test before any build |
| A line on every prompt passes the replay by construction and is easy to skip | Not shipped without the offline test |

---

## 8. The offline test · 20 October

```
 passed the rubric (4 real failing turns, 3 answers each, Opus 5.5 answering, Sonnet 5.5 grading)

 V0 today                          0 of 12   ▏                      median 605 words
 V1 + a "keep it short" rule       0 of 12   ▏                      median 431 words
 V2 always section + handle line   0 of 12   ▏                      median 621 words
 V4 rules reworded, concrete       4 of 12   ████                   median 265 words
 V5 V4 + a plain reminder line     1 of 12   █                      median 241 words
```

**What fixed it was the wording of the rules, not where they sit.** When the rules said exactly what to do ("under 200 words, answer first, at most 5 points"; "no code names, file names, hashes or flags; describe problems by what the person sees"), the length cases went from 0 of 6 to 4 of 6, and answers got about 60% shorter. Moving the same vague rules to the top did nothing, and neither did a reminder on every prompt. That matches what `CLAUDE.md` already showed.

| Case | Rule | V0 today | V4 reworded |
|---|---|---|---|
| b26649ab | bf351a, plan docs short and visual | 0 of 3, 770 words | 2 of 3, 271 words |
| f7f5831f | bf351a | 0 of 3, 691 words | 2 of 3, 240 words |
| 8b3d6216 | 1db602, plain words | 0 of 3, 328 words | 0 of 3, 214 words |
| 1beb9134 | 1db602 | 0 of 3, 524 words | 0 of 3, 303 words |

**Jargon is not fixed yet.** The reworded plain-words rule took out the code names, but the judge still failed every answer for words like "commit", "rebased branch" and "sandbox". I feel part of that is a strict judge, since you work with PRs every day. But it is still the weakest case.

<details>
<summary>+ How the test was run, and its limits</summary>

- 5 real failing turns were rebuilt from transcripts: the start block as it was, up to 8 earlier exchanges, a summary of the tool work in that turn, and the message the agent answered badly. 9 complaints were left out (code work, a session's first message, or not found). The merge case (602b570f) was dropped after the run, because its tool work showed a permission check blocking the merge, so it could not test following.
- Answers came from `claude -p` with Opus 5.5 on your subscription, with Satchel's plugin, hooks and MCP off. A judge (Sonnet 5.5) saw only the rubric and the reply. The 5 original replies all failed the same judge.
- A rebuilt turn without live tools is not the live agent, and 12 answers per version is small. But 0 of 12 against 4 of 12, with every length case 50 to 65% shorter, is not noise.
- Files, with your words, stay local: `~/satchel-daily/following-test/`.
</details>

### What this changes

| | Mark |
|---|---|
| Reword 1db602 and bf351a, and add a "keep replies under 200 words" rule, in your memory | Open, needs your yes |
| Root cause: the nightly pass saves rules in your loose words ("simple", "readable"), which the agent does not act on. The pass should save preferences as concrete, checkable instructions. That is a prompt change, with its own eval | Open, next |
| The always section and the per-prompt line | Not built. Measured: no effect |

## Decided · 20 October

| What |
|---|
| Rule placement changes are not built: 0 of 12, same as today |
| The fix is concrete rule wording: 4 of 12 against 0 of 12 |

