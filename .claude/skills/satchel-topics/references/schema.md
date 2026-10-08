# Topic schema and mutations

## `topics`

| Column | Notes |
| --- | --- |
| `id` | UUID, primary key, supplied by the caller |
| `owner_id` | defaults to `auth.uid()`, cascades from `auth.users` |
| `name` | 1..100 characters after trimming |
| `brief` | <= 1000 characters, defaults to empty |
| `slug` | lowercase words joined by hyphens, 3..40, unique per owner |
| `revision` | `bigint > 0`, bumped by a trigger |
| `created_at`, `updated_at` | |

`unique (owner_id, id)` exists so every other table can carry a composite foreign key on `(owner_id, topic_id)`. Keep it.

`stamp_topic_revision` is a `before update` trigger that sets `revision = old.revision + 1` and `updated_at = clock_timestamp()`. Nothing sets the revision by hand.

## The two write paths

**`create_topic(p_id, p_name, p_brief)`** is the original companion path: `security invoker`, insert with `on conflict do nothing`, then re-read and compare. If the row exists with different content it raises `PT409`. That makes a retry with the identical payload safe without a receipt table. The companion still uses it, then calls `set_slug` to replace the derived slug with one the person would actually say.

**`upsert_topic(...)`** is the path with a receipt, and the one agents use, through the `upsert_topic` tool and `upsert_topic_with_slug`:

- `p_expected_revision is null` means create with the supplied `p_topic_id`.
- A supplied revision means update, and a mismatch is `PT409`.
- `p_repository_action` is `unchanged`, `link` or `unlink`, and the repository change happens in the same transaction as the name and brief.
- It returns `{topic, repositories[], grant_required}`.

A companion caller (`auth.jwt()->>'client_id' is null`) may always manage. An agent caller needs `can_write` **or** `task_can_write` on the live connection, and updating an existing topic additionally needs `agent_can_access(id, true)` or `agent_can_access_tasks(id, 'write')`. That second condition was widened deliberately in `20260917043508_project_upsert_task_grants.sql`: a connection granted tasks but not memory still has to be able to name its own topic.

`grant_required` is `true` when the caller is an agent and the topic is not readable through either the memory grant or the task grant. Creating a topic never adds it to a grant. Surface this; do not swallow it.

## `topic_write_requests`

`(owner_id, request_id)` primary key, an md5 `payload_hash` over the canonical JSONB, the resulting `topic_id`, the stored `result` and `completed_at`. RLS on, every grant revoked: the table is internal to the routine. Same ID and same payload returns the stored result; same ID and a different payload raises `PT409`. A `unique_violation` from a concurrent duplicate is caught and turned into `PT409` as well.

## Slugs

The slug is how a person refers to a topic out loud, and how a captured memory can name a topic without a join. Rules:

- `^[a-z0-9]+(-[a-z0-9]+)*$`, 3 to 40 characters, unique per owner.
- Supplied on create, never derived from the name. A derived slug is something nobody would say.
- `default_slug` is a `before insert` trigger on both `topics` and `tasks`, so no row can lack one. It reads the label through `to_jsonb(new)` because a topic has `name` and a task has `title`, and one trigger is better than two that drift.
- `set_slug(kind, id, slug)` is the only routine that changes one. The column is never directly writable.
- `upsert_topic_with_slug` wraps `upsert_topic` plus `set_slug` so a create and its slug are one transaction, then patches the slug into the returned JSON.

`slugify()` exists only for the backfill and for write paths that predate slugs. It is not the intended way to get one.

## `delete_topic`

Companion only, through `private.companion_only()`. It takes the id and the expected revision, locks the row `for update`, and then:

1. counts the memories and tasks it is about to remove;
2. collects every `storage_object` key in the topic and drops those objects through `private.drop_task_files`;
3. deletes the topic's task write receipts;
4. removes the topic id from every `agent_connections.topic_ids` array;
5. deletes the topic, which cascades to memories, tasks and repository links;
6. returns `{id, name, memories_removed, tasks_removed, files_removed}`.

The counts are returned so the UI can say what it took before and after. `src/features/topics/TopicDelete.tsx` asks first.

Note step 4 only touches the explicit list. A connection with `all_topics` has no list to clean, and does not need one.

## Reading topics

The agent path is `memoryService.topics()`: a plain select of `id,slug,name,brief,revision,updated_at` plus the embedded `topic_repositories(provider,repository)`, ordered by name, and RLS narrows it to what the connection may see. The companion path (`src/features/topics/repository.ts`) selects the same columns plus `created_at` and orders by creation.

The `list_topics` MCP tool returns the effective connection permissions alongside the topics, and catches a failure of the topic query separately (`topics_error`), so diagnosing a broken connection never depends on the topic query succeeding.
