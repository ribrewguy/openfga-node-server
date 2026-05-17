# Document Sharing

A Google-Docs-style model: documents have owners, individual users
or groups can be granted view or edit, and folder access cascades
to contained documents.

## The model

```fga
model
  schema 1.1

type user

type group
  relations
    define member: [user, group#member]

type folder
  relations
    define owner:  [user]
    define editor: [user, group#member] or owner
    define viewer: [user, group#member] or editor
    define parent: [folder]
    define viewer_inherited: viewer or viewer_inherited from parent
    define editor_inherited: editor or editor_inherited from parent

type document
  relations
    define parent: [folder]
    define owner:  [user]
    define editor: [user, group#member] or owner
    define viewer: [user, group#member] or editor or viewer_inherited from parent
```

Two features worth noticing:

1. **Group expansion via `group#member`.** Granting a group view on
   a doc means every member of the group gets view, recursively
   (groups can contain groups via `[user, group#member]`).
2. **Folder inheritance via `viewer_inherited from parent`.** A
   document's viewer set includes anyone with `viewer_inherited` on
   the parent folder, which recursively includes the grandparent,
   etc.

## Seed

```sh
STORE_ID=$(curl -sS -X POST http://localhost:8080/stores \
  -H 'Content-Type: application/json' \
  -d '{"name":"docs-recipe"}' | jq -r .id)

STORE_ID=$STORE_ID pnpm load-model your-docs.fga

curl -sS -X POST http://localhost:8080/stores/$STORE_ID/write \
  -H 'Content-Type: application/json' \
  -d '{
    "writes": { "tuple_keys": [
      { "user": "user:alice",                "relation": "member", "object": "group:eng" },
      { "user": "user:bob",                  "relation": "member", "object": "group:eng" },
      { "user": "user:carol",                "relation": "member", "object": "group:eng-leads" },
      { "user": "group:eng-leads#member",    "relation": "member", "object": "group:eng" },

      { "user": "user:alice",                "relation": "owner",  "object": "folder:engineering" },
      { "user": "group:eng#member",          "relation": "viewer", "object": "folder:engineering" },

      { "user": "folder:engineering",        "relation": "parent", "object": "folder:engineering/projects" },
      { "user": "folder:engineering/projects", "relation": "parent", "object": "document:engineering/projects/q1-roadmap" },

      { "user": "user:carol",                "relation": "editor", "object": "document:engineering/projects/q1-roadmap" }
    ]}
  }'
```

## Sample checks

### Bob (engineering group member) can view the doc via folder inheritance

```sh
curl -sS -X POST http://localhost:8080/stores/$STORE_ID/check \
  -H 'Content-Type: application/json' \
  -d '{
    "tuple_key": { "user": "user:bob", "relation": "viewer", "object": "document:engineering/projects/q1-roadmap" }
  }'
# { "allowed": true }
```

Trace:
`document.viewer → viewer_inherited from parent (folder.projects)
 → viewer_inherited from parent (folder.engineering)
 → viewer (folder.engineering) → group:eng#member → user:bob`

### Carol has explicit editor access on the doc

```sh
curl -sS -X POST http://localhost:8080/stores/$STORE_ID/check \
  -H 'Content-Type: application/json' \
  -d '{
    "tuple_key": { "user": "user:carol", "relation": "editor", "object": "document:engineering/projects/q1-roadmap" }
  }'
# { "allowed": true }
```

### Group-of-groups also works

```sh
curl -sS -X POST http://localhost:8080/stores/$STORE_ID/check \
  -H 'Content-Type: application/json' \
  -d '{
    "tuple_key": { "user": "user:carol", "relation": "viewer", "object": "folder:engineering" }
  }'
# { "allowed": true }
```

Carol is in `group:eng-leads`. `group:eng-leads#member` is itself a
member of `group:eng`. The viewer grant on the folder is to
`group:eng#member`, which recursively expands to include
`group:eng-leads#member`, which expands to Carol.

## Sharing patterns

### Share a folder with a user

```sh
curl -sS -X POST http://localhost:8080/stores/$STORE_ID/write \
  -H 'Content-Type: application/json' \
  -d '{
    "writes": { "tuple_keys": [
      { "user": "user:dave", "relation": "viewer", "object": "folder:engineering/projects" }
    ]}
  }'
```

Dave can now view every document under
`folder:engineering/projects` (and deeper).

### Revoke a sharing

```sh
curl -sS -X POST http://localhost:8080/stores/$STORE_ID/write \
  -H 'Content-Type: application/json' \
  -d '{
    "deletes": { "tuple_keys": [
      { "user": "user:dave", "relation": "viewer", "object": "folder:engineering/projects" }
    ]}
  }'
```

Atomic; Dave loses access on the next `check`.

### Move a document to a different folder

```sh
curl -sS -X POST http://localhost:8080/stores/$STORE_ID/write \
  -H 'Content-Type: application/json' \
  -d '{
    "deletes": { "tuple_keys": [
      { "user": "folder:engineering/projects", "relation": "parent", "object": "document:engineering/projects/q1-roadmap" }
    ]},
    "writes": { "tuple_keys": [
      { "user": "folder:engineering/archive", "relation": "parent", "object": "document:engineering/projects/q1-roadmap" }
    ]}
  }'
```

The doc's inherited viewers immediately switch to the new folder's
viewers. No reindex; the evaluator walks fresh on every check.

## Listing — "what can I see?"

```sh
curl -sS -X POST http://localhost:8080/stores/$STORE_ID/list-objects \
  -H 'Content-Type: application/json' \
  -d '{ "type": "document", "relation": "viewer", "user": "user:bob" }'
```

For a UI that paginates "documents shared with me," call
`list-objects` and join the result with your own document metadata
store.

## Cost considerations

Folder inheritance can produce deep traversal trees. For very deep
folder structures (>10 levels), evaluator latency grows. The
evaluator memoizes within a single check, but cross-check caching is
not implemented today.

In practice this is fine for typical sharing depths (~3–5 levels).
If you have pathological depth, consider flattening on the
application side — store a denormalized "ancestor folders" list and
check against that explicitly.

## See also

- [GitHub-Style Permissions](/recipes/github-permissions) — team
  membership
- [Auth0 / Okta FGA SDK Client](/recipes/sdk-client) — `@openfga/sdk` integration
