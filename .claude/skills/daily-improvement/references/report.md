# Report shape

Written to `<folder>/report.md`. Plain words, short sentences, tables where they help. Every claim points at a session id, and every quote is the person's own words, under 15 words.

The first line is the following score, copied from the first line `said-again.mjs` prints once every mark is filled (SKILL.md step 10). `<n> complaints` counts only complaints on a rule that was in that session's start block; the score divides them by the sessions that got a start block in the same 4 weeks. It holds numbers only.

```markdown
following: <n> complaints in 4 weeks · per 100 sessions: <x> · 4 weeks before: <y> · up-front <n> · unlabelled <n>

# Consolidation review · <date>

Window <since> to <until> · <n> jobs · <n> sessions read · model <model>, thinking <level>
Langfuse: <n> of <n> runs traced · <n> waited · <n> errors · cost $<x>

## The numbers

|                         | pipeline | blind | both |
|-------------------------|---------:|------:|-----:|
| changes                 |          |       |      |
| sessions with any       |          |       |      |
| topic-scoped            |          |       |      |
| new topics named        |          |       |      |
| intents                 |          |       |      |
| affirm / extend / replace / retire |  |    |      |

Memory set now: <n> live · by scope ... · by kind ...

## What it got

One line per change that landed, with a verdict: good, noisy, wrong, stale-prone.

## What it missed

Only blind-only changes you judged real misses, strongest first. Misses seen in more than one session go first.

| what they said | sessions | kind · scope | why it counts |

Blind changes you judged over-reach, in one line each, so tomorrow's reviewer does not relitigate them.

## Actions it could have taken

Existing memories the conversation affirmed, extended, contradicted or finished, that the pass left alone.

Said again: <n> affirms on <n> rules at 2+ · complaint <n> · up-front <n> · top <handle> x<n>, in block <n> of <n>

## Topics

From `topics.md`. One line each, with a verdict.

| | count | verdict |
|---|---:|---|
| topics made | | each: real subject, named for the area? |
| memories moved | | each: right topic, or should it have stayed personal? |
| merges / undone | | each: really one subject? |
| work facts still in personal | | which ones, and why the tidy left them |
| thin topics / name overlaps | | one subject or two? |

Enhancements: briefs that no longer fit, topics that grew into two, repositories that belong to a topic and are not linked. Each one is a TODO, for the person or for the code.

## Gaps

The checklist from SKILL.md, each answered with numbers, then a root cause with a file:line.

## TODOs

| # | P | TODO | evidence | where | how to verify | seen |

Carried-forward ones first, with how many reviews have seen them. Mark any that landed since the last review as done, with the commit.

## Compared with the last review

What moved: numbers up or down, TODOs closed, new patterns.
```
