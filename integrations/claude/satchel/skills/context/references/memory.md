# Memory

Durable facts worth carrying between conversations: preferences, decisions, standing context.

## Shape

A memory is **one sentence**. That sentence is the whole record and it is what you are given, so there is nothing to fetch before you can use it.

| Field | |
| --- | --- |
| `statement` | the memory, up to 500 characters. This is what loads. |
| `band` | `said` or `heard`. See below; it changes how you may use it. |
| `name` | an optional handle. Most memories have none. |
| `more_info` | rare. The index tells you with `has_more_info` when a row has any. |

A memory belongs to one scope, personal or one project, and never to a task.

Every row also has a six-character handle, the start of its id. That is what the user sees in their app, so it is the right thing to say when you mean a particular memory.

## Said and heard

`heard` means Satchel picked this up from a conversation and the user has never confirmed it. **Say a heard memory out loud before you rely on it.** One sentence is enough: name what you are about to assume and carry on. If the user agrees, call `confirm_memory`. If they correct it, `correct_memory` does both at once.

`said` means the user saved or confirmed it themselves. Use it without ceremony.

## Reading

You are given memories two ways and should not ask for them a third.

1. **At the start of a conversation**, and after compaction, you receive the personal memories and the list of projects. Personal memories apply whatever you are working on, so they are not searched for, they are simply present. Ones Satchel picked up from what the user said come under their own header: follow them unless the user tells you otherwise, and do not ask them to confirm one. The block is capped, so a personal memory can exist without being in it: search when the user refers to one you were not given.
2. **On each message**, anything relevant to what the user just said is retrieved and handed to you, with counts: `2 shown · 5 matched · 130 in scope`. Those counts are the point. `0 matched` means there is no such memory, which is different from one existing and not being shown.

Call `retrieve_memory` yourself only when you need something the turn did not surface, for example a topic the user has not named yet in this conversation. Pass `exclude` with ids already in the conversation so nothing arrives twice. Do not read a whole scope with `memory_index` to go looking; search instead.

A project memory can arrive with a note that its repository has moved some number of commits since it was last confirmed. That is a doubt, not a verdict. Check the code before relying on it, and if it is still true and the user agrees, `confirm_memory` clears the doubt.

`read_memory` takes a scope and an id, and is only for the rare row whose `has_more_info` is true.

## Saving

`save_memory` takes `project_id`, a fresh `id` UUID, and `statement`. Optionally `source`, `name` and `more_info`. There is no `task_id`.

Save only when the user asks you to remember something. Write the statement so it still makes sense in six weeks, with no pronouns pointing at this conversation. An explicit save is confirmed by definition, so it is stored as `said`.

A memory that is about a task is still saved to the task's project, or to personal. If what the user said is really a piece of work to do, it may belong in a task instead, and that is a separate, explicit request.

## Correcting and forgetting

`correct_memory` takes `project_id`, `id`, the current `revision` and the replacement `statement`. Read first so the revision is one you have actually seen. On `PT409`, re-read and show the user what changed. Correcting also confirms, because the user just told you what is true.

`confirm_memory` takes `id` and `revision`, and does nothing else. Use it when the user agrees with a heard memory but changes nothing.

`forget_memory` takes scope, id and revision. Forget only the memory the user asked to forget, and tell them copies already printed in earlier chats are unaffected. It stops loading and matching right away and moves to the archive in the Satchel app, where the user can restore it. On `PT409`, re-read: it changed, or it is already forgotten. There is no tool to delete a memory for good. If the user wants that, point them to the archive in the Satchel app.
