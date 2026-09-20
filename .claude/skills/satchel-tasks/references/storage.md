# Task files, export and cleanup

Postgres owns the metadata and the lifecycle. Supabase Storage owns the bytes. They cannot share a transaction, which is why every part of this is two-phase and why the failure states are explicit.

## The bucket

Private bucket `task-files`, created through the Storage API or Dashboard, never by inserting into Storage's own metadata tables. `npm run task-storage:provision` (`scripts/provision-task-storage.mjs`) creates it. The database migration installs the object policies when the hosted Storage schema is present.

The object key is exactly:

```
{owner_id}/{task_id}/{resource_id}
```

Three UUIDs and nothing else. The original filename is metadata on the row, never part of the key, because a key is visible in more places than a row is.

## The upload lifecycle

```
reserve metadata -> pending -> upload bytes -> verify size and checksum -> verified
                                  \__________ failure ___________________ -> failed
```

1. `reserve_task_file` checks upload capability, mints the immutable key, records the expected byte count and SHA-256, and advances the task revision.
2. The client uploads to that exact key. Storage policy allows insert **only** at a pre-reserved pending key, for a caller with upload capability.
3. `finalize_task_file` reads the object metadata and compares size and checksum. Match is `verified`; mismatch is `failed` with a diagnostic event.
4. `fail_task_file` records a client-side upload failure.

Standard uploads are capped at 6 MB in this slice. Anything larger needs a resumable-upload flow that does not exist yet.

There is no overwrite, no update, no delete and no public access in the Storage policies. Download is authenticated and only for a `verified` resource whose caller has read capability. Signed URLs are not used; if they are ever added they are bearer credentials valid until expiry and must be short-lived.

A failed verification never becomes readable. Test that.

## Binary transfer is a companion operation

MCP stores links and metadata. It does not move bytes. An agent can attach an `external_url` and can read a resource row, but uploading and downloading files is the companion's job. Do not add a file-transfer MCP tool without deciding that separately.

## Export

`export_tasks` returns an RLS-scoped JSON manifest of tasks, handoffs, resources, references and events. A database backup does **not** contain Storage bytes, so a recoverable backup is three things:

1. the `export_tasks` manifest, preserving identities, checksums and object keys;
2. an authenticated download of every `verified` storage object in it;
3. a restore drill that recreates the objects at their immutable keys and then restores the rows.

The companion's scope export does steps 1 and 2. The drill is still release-hardening work.

## Cleanup

`npm run task-storage:cleanup` (`scripts/cleanup-task-files.mjs`) removes failed or pending reservations older than 24 hours and records deletion events. It is bounded and deliberately a command, not something hidden inside a request transaction. Scheduling it is an operational choice that has not been made.

Deleting a task or a project drops its storage objects through `private.drop_task_files`, which is a definer routine that no role can execute directly and which no-ops when `storage.objects` does not exist (the local SQL harness).
