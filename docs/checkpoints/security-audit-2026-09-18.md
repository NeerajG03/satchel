# Pre-launch security audit — 18 September 2026

Status: **local review passed; live two-account verification remains required**.

This checkpoint covers source revision `d6fefc2f91bfae60b19f88009d754086a0843977` plus the uncommitted audit changes described below. It is not a production certification and does not complete the Satchel task until the live rows are performed with two real accounts.

## Security outcome under test

One signed-in user must not be able to discover, read, create, change, delete, export or revoke another user's memories, projects, tasks, task history, task files or agent connections. An agent receives only the personal and project scopes in its current grant. Revocation must stop an unexpired token immediately, and re-consent must issue a new grant generation rather than revive an old token.

The audit treats these as separate trust boundaries:

| Boundary | Required property |
|---|---|
| Browser companion → Supabase | A normal user JWT sees only rows owned by `auth.uid()`; OAuth-client tokens cannot call companion-only grant administration. |
| OAuth token hook → MCP | The token has the Satchel MCP audience, a client ID and the current opaque grant generation. Missing, expired, wrongly issued or wrongly scoped tokens fail before MCP dispatch. |
| MCP → database | Every read and write is checked again against current connection state, owner, project/personal scope and capability. Revocation is effective even while an access token has time remaining. |
| Task files → Storage | Object names are opaque owner/task/resource paths. Reads require a verified resource and task read access; uploads require a pending reservation and upload capability. |
| Local lifecycle hook → repository hint endpoint | The anonymous request carries only a high-entropy session key and normalized GitHub repository identity. It returns no data and cannot grant a project; authenticated activation still requires an owner link and current project grant. |

## Automated evidence

Run from the repository root:

```sh
npm test
npm run build
npm audit --omit=dev --audit-level=high
git diff --check
```

The database harness applies every migration in order and exercises RLS and security-definer routines as `anon`, two different companion users and multiple OAuth clients. The relevant assertions cover:

- every application table in `public` has RLS enabled, every security-definer routine pins `search_path`, anonymous routine execution is limited to repository-hint staging, and authenticated users cannot invoke the Auth token hook or file-cleanup routine;
- same-name memories across owners and scopes, known-ID read/update/delete attempts, direct table operations and RPC operations;
- owner-scoped connection rows, identical client IDs under different owners, companion-only authorize/revoke, grant generations, revoke and narrower re-consent;
- project and personal task grants, known-ID cross-owner reads and transitions, task comments, progress, handoffs, relationships, events and resources;
- task-file reservation, opaque object identity, metadata verification, cross-owner read predicates and finalize attempts;
- repository links and anonymous hints that resolve only through the consuming user's already-authorized link;
- token issuer, audience, expiry, client ID and grant-generation claims;
- incomplete-index and injected-memory framing at the MCP boundary.

The production dependency audit reported zero known vulnerabilities. `.env` is ignored and untracked; a tracked-source scan found no private-key material or committed access/refresh tokens.

## Findings and disposition

### F1 — Parsed repository-hint bodies bypassed the endpoint's byte check

Severity: medium availability risk, no demonstrated data disclosure.

`handleRepositoryHint` rejected a raw request above 1 KiB using `Content-Length`, and `parseRepositoryHint` bounded strings and buffers. In the Vercel path `req.body` is normally already an object, so an object could include large unrelated fields and bypass the parser's own limit after the platform had parsed it.

Disposition: fixed in this audit. The parser now serializes and bounds object input, rejects fields other than `session_key`, `provider` and `repository`, and tests raw and parsed oversized requests without calling Supabase.

### F2 — Cross-owner tests did not cover every new task/connection surface

Severity: evidence gap.

The existing suite proved owner isolation for memories and basic task listing, but did not explicitly attempt known-ID reads across task handoffs, updates, resources and events, cross-owner transitions/finalization, or revoking an identical client ID owned by someone else.

Disposition: fixed in this audit. These negative cases are now regression tests. They confirm empty RLS projections or authorization-safe errors and verify that the other owner's connection remains active.

### F3 — Repository-hint staging is intentionally anonymous

Severity: low confidentiality/authorization risk; residual availability risk.

The command hook cannot rely on MCP OAuth being ready, so staging accepts an anonymous, short-lived capability. It exposes no read operation or response body, accepts no owner/project/grant fields, and activation can select only a repository linked by the authenticated owner to a project already in that connection's grant. A party that obtains an active session key could overwrite or consume its hint, causing a missed automatic selection, but cannot use the hint to read a project. Random guessing is constrained by the host-generated session key; rows are ignored after five minutes and expired rows are removed during later staging.

Disposition: accepted for the private pilot with the stricter 1 KiB/schema checks. Before a broader or public launch, add edge request-rate controls and alerting for the hint endpoint, then repeat the abuse test. Do not describe the endpoint as immune to denial of service.

### F4 — Real-account validation is not replaceable by the SQL harness

Severity: release gate.

The local harness accurately exercises policies and routines, but it does not prove the hosted Auth hook is enabled, deployed migrations match source, Storage policies are active, refresh/revoke behavior works through the real provider, or the consent UI submits the intended grants.

Disposition: pending. Complete the matrix below with a second real account before closing the task.

## Hosted unauthenticated probes

The following non-mutating or deliberately invalid production requests were checked on 18 September 2026:

| Request | Result |
|---|---|
| `GET /api/repository-hint` | `405 Method Not Allowed` |
| Invalid-provider `POST /api/repository-hint` | `400 Bad Request`; no hint staged |
| `POST /api/mcp` without a bearer token | `401 Unauthorized` |
| `GET /.well-known/oauth-protected-resource` | `200 OK` |

These probes establish public failure behavior only. They do not establish two-account isolation or prove that the current audit patch has been deployed.

## Live two-account matrix

Use synthetic names and bodies only. Record account labels, deployed commit, time, client/app version, selected grants and pass/fail; never record access tokens, refresh tokens or private memory bodies.

1. Sign in as Account A and Account B in isolated browser profiles. In each, create a project with the same display name. Create a personal memory, project memory, project task and small task file whose marker is unique to that account.
2. In each account, connect a separate fresh OAuth client. Grant one project and no personal scope. Confirm its project/memory/task lists contain only that account's selected project and omit the other account even when exact UUIDs and names are supplied.
3. Attempt known-ID reads and writes against the other account's memory, task, handoff, update, resource and file identity through MCP and direct authenticated RPC. Required result: empty/unavailable/denied, with no existence-revealing detail.
4. In Account A, revoke the client while its agent session remains open. Required result: the next MCP request fails, direct RPC returns no rows or is denied, Account B remains usable, and content already present in chat is accurately described as not erasable.
5. Re-consent the same Account A client with a narrower grant. Required result: the old token remains unusable; only a newly issued token works and it exposes only the new grant.
6. Deny a new OAuth authorization. Required result: no Satchel connection row or usable grant is created and the client reports authentication/setup failure without memory data.
7. Stage a repository hint for a repository linked only by Account A. Try to consume the known fixture session key through Account B's valid client. Required result: no project ID, metadata or memory is returned. Restage with a new key and consume through Account A; selection may occur only if that project is already granted.
8. Upload and verify Account A's task file. Required result: Account B cannot download it by object path or finalize/fail its resource. Revoke Account A's task read grant and confirm download stops.
9. Review the connection screen before approval and after re-consent. The displayed client name is labelled client-provided, return URI is visible, memory/task scopes match the submitted RPC, and write/upload permissions are not broader than selected.
10. Delete all synthetic fixtures and retain only this results sheet. A failed row keeps the task open and records a reproducible finding before any fix.

## Completion rule

The ticket may move to `done` only when every live row above passes against the deployed revision, or each failure has a documented, explicitly accepted disposition in the decision ledger. Local automated evidence alone is insufficient.
