---
name: prompt-management
description: How to change a Satchel model prompt (server/prompts/consolidate.md, capture-router.md) without making it worse. Use before editing any prompt, when a review TODO says "fix the prompt", or when adding eval cases for a prompt change. Covers the shape a prompt must have (goal first, guardrails, examples, not a list of steps), how to prove a change with before and after numbers, what it costs, and how it ships.
---

# Changing a prompt

A prompt here is the whole brief for a model that works alone, at night, on a person's real conversations. It has to state what good looks like and what must not happen. It must not be a recipe. A model given a recipe follows the recipe and misses the case the recipe did not list. A model given a goal, some fences and a few examples can handle the case nobody wrote down.

Neeraj's rule, 1 October: **goal oriented, with guardrails and examples, not instruction oriented.**

## The shape

```
 GOAL        what the next reader of the result should be able to do
   │         ("already know what they said that will still hold in six weeks")
   ▼
 WHAT COUNTS the kinds of thing, each with one line on why and one example
   │
   ▼
 GUARDRAILS  what must not happen, each with the mistake it prevents
   │         (a bare "yes" is not their design; a claim they argue against is not theirs)
   ▼
 OUTPUT      each field in a line: what it holds, not how to compute it
```

| Do | Do not |
|---|---|
| Say the goal in the first lines, in plain words | Open with "Step 1, step 2" |
| Give a guardrail the reason it exists | Add "NEVER" or capitals to make a rule louder |
| Teach a shape with two or three short examples worded differently from each other | Give one example, because the model copies its words |
| Say what to do when unsure, once | Repeat the same rule in three sections |
| Remove a line when you add one that covers it | Only add. The consolidation prompt went from 9,305 to about 5,000 characters in one rewrite and scored better |

A prompt that keeps growing is a sign that each fix was written as a new instruction. Fold the fix into the sentence that already owns that idea.

## Before you edit

1. **Start from evidence, not a feeling.** The daily review (`daily-improvement`) gives session ids and the user's words for each miss. A change without a quote is a guess.
2. **Name the cause.** Is the prompt wrong, or is it the input (a turn cut short, a project not shown), a validator, or noise from the model? `daily-improvement` step 6 says how to tell. A prompt edit cannot fix a missing input. On 1 October the same two rules the pass missed overnight were caught by the old prompt on replay, so that miss was noise, and no edit was needed.
3. **Run the case on the current prompt first.** If it already passes in isolation, the miss is about a long or busy session, and a new sentence will not help. Say so and look at the input or the model setting instead.
4. **Read the whole prompt**, not only the section you mean to touch. Find the sentence that already owns the idea and change that one.

## Writing the change

- Add the smallest thing that covers the shape, not the sentence. "A reaction to what you just built counts the same way" covers a shape. A rule about metrics covers one sentence.
- **Examples must not equal an eval case.** If the prompt says "prove the before and after" and the case says the same, the case tests memory of the prompt, not the rule. Word the prompt example differently ("show me it works before and after").
- An example list can pull in the wrong thing. A list in the project rule once made a rejected claim come back as a fact (`rej01`, 14 of 14 on main, 6 of 9 with the list). Run the guarding cases after adding any list.
- Keep the user's own word for a thing in the prompt only when the model has to match it.
- No ticket numbers, dates or names of people in a prompt.

## Proving it

Evals spend money. The rules are in `daily-improvement` ("Evals cost money") and they hold here.

```
 1. add cases from the real misses, word for word      (eval/consolidation-cases.json)
 2. run only those cases on the current prompt          --only <category> --repeat 3     = BEFORE
 3. edit the prompt
 4. run the same slice again                            = AFTER
 5. replay the real sessions, old against new           daily-improvement replay.mjs
 6. run the full suite once                             node eval/consolidation.mjs
```

- Slice first. Repeat only what changed, up to 3. Do not re-run `main` for a number you already have.
- A case that fails before and after on a shape that is really arguable is a bad case. Remove it and say so in the PR (`log01`, 1 October: "note it in your log" read as a job, not a rule).
- A case that passes before and after proves nothing about the change. Keep it as a guard, and say it is a guard.
- `want` matches words, so "emoji" does not match "emojis". A case should test one thing.
- Replay a few real sessions old against new. One sample per side is noise, so a difference of one or two changes means nothing. A shape going from 0 to 2 or more on both runs is a signal.
- The full suite is for regressions: quiet cases must stay quiet, nothing may end wrongly. `jr02` fails on main too, so it is not yours.
- Put the numbers in the PR: before, after, what the replay showed, what you did not prove.

## Shipping

- The prompt file is read by production directly (`promptSource: local` in the Langfuse trace), so a merge ships it. `scripts/push-prompt.mjs` only records a version in Langfuse for the history. Check `promptSource` in the next review's `langfuse.json`.
- Record the change in the daily log (`~/satchel-daily/log.md`) under "changes beyond the review": the PR, the eval rows, the spend.
- Close the review TODO it fixes in the next report, and add the number that should move.

## Checklist

- [ ] The change starts from a quote and a session id
- [ ] I ran the case on the current prompt first
- [ ] The prompt is the same length or shorter, or I can say why not
- [ ] Goal first, guardrails with reasons, examples that differ from the eval cases
- [ ] Before and after numbers, a replay, one full run
- [ ] PR says what was not proven
