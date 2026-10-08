# Topics

## Slugs

Every topic has a `slug` on the same rules as a task's: lowercase words joined by hyphens, three to forty characters, unique across everything this user owns. `list_topics` returns it, and it is what the session block shows.

`upsert_topic` requires one when creating. Use the short name the user already says for the topic rather than a slugified version of its full name.


A topic is the scope that memories and tasks hang off. It is always an explicit UUID from `list_topics`, never a folder name and never a name guessed from repository contents.

## Inspecting the connection

`list_topics()` returns this connection's effective permissions and only the topics it may access. It is the diagnostic tool: when any call is denied with `42501`, call it to see which grants actually exist, then guide the user through the host's MCP login or ask them to authorize the topic in Satchel.

It deliberately still returns connection permissions when the topic query itself fails, reporting `topics_error`. A broken topic list is not proof that the connection is broken.

## Selecting the active topic

`select_topic(session_key, topic_id | repository, event?)`.

- Provide exactly one of `topic_id` (with `null` meaning personal scope) or `repository`. Both or neither gives `PT400`.
- `session_key` comes from the hook context. If none is available, do not invent one: use the explicitly scoped memory and task tools instead.
- `repository` resolves only through the server-side link table, and only to a topic already inside this connection's grant. `PT404` means the repository is not linked or not granted: report that topic context was not loaded, and do not fall back to a similar-looking topic.
- Pass `event` only to recover a session whose Satchel hook did not run, on a new conversation or after compaction. It returns what that hook would have injected.

Selection affects this conversation only. It never changes another conversation and never grants permissions. Tell the user which scope you selected.

The return value is the combined personal plus topic index. Check `complete` before claiming everything is loaded. If it comes back with `index_error`, the scope change still committed: the selection succeeded and only the index read failed, so retry the index rather than reselecting.

## Creating and revising

`upsert_topic(topic_id?, expected_revision?, slug, name, brief, repository_change)`, on explicit request only.

- Omit `topic_id` and `expected_revision` to create. Satchel returns the new topic ID.
- Provide the current `expected_revision` to update an already authorized topic.
- `repository_change` is `{kind:'unchanged'}`, `{kind:'link', repository}` or `{kind:'unlink', repository}`, and touches one normalized lowercase `owner/repository` without disturbing other links.

Creating a topic does not expand this connection's grant. When the response sets `grant_required: true`, say plainly that the topic exists but this connection cannot use it yet, and that the user has to authorize it in Satchel first. Do not retry the failing call in the meantime.

`grant_required` comes back `false` when the connection was given every topic rather than a list of them. `list_topics` reports which it is: `all_topics: true` means the grant covers topics made after it was given, so a topic you just created is usable straight away. Otherwise the grant is a fixed list and a new topic is outside it until the user says otherwise.
