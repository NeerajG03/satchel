# Memory

Durable facts the user explicitly asked to keep: preferences, prior decisions, standing context. Hooks read the memory index only. They never save or summarize a conversation.

## Shape

A memory has a `name` (<=100 chars), a `description` (<=280 chars) and optional `more_info` (<=40000 chars). The index carries names and descriptions only, so it stays small enough to load every session. Details are fetched on demand.

## Reading

1. Use the index already loaded by the lifecycle hook. Call `memory_index` with an explicit `project_id` only when you need one scope that is not loaded, or when the loaded index reported `complete: false`.
2. Scan names and descriptions for relevance.
3. Call `read_memory` with `project_id`, `name` and `expected_id` for the few that matter.

`expected_id` comes from the index and detects a rename or a reused name. Names can repeat across scopes, so the ID is what pins the record. Do not pull `more_info` for every memory: the index exists so you do not have to.

## Saving

`save_memory` takes `project_id`, a fresh `id` UUID, `name`, `description` and optional `more_info`.

Save only on an explicit request to remember something. Choose personal or project scope explicitly. Do not silently copy a project secret into personal scope.

`23505` means the name is already used in that scope. That is a real collision: ask whether to correct the existing memory rather than inventing a variant name.

## Correcting

`correct_memory` takes `project_id`, `id`, the current `revision`, and the full replacement `name`/`description`/`more_info`.

Read the record first so the revision is one you have actually seen. On `PT409`, re-read and show the user what changed. Never overwrite an unseen correction automatically.

## Forgetting

`delete_memory` takes `project_id`, `id` and the current `revision`.

Delete only the specific memory the user asked to forget. Tell them that copies already printed in earlier chats are unaffected.
