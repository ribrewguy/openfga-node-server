# GitHub-Style Permissions

A small but realistic model: users, organizations, teams,
repositories. Mirrors the upstream OpenFGA
[`github` sample](https://github.com/openfga/sample-stores).

## The model

```fga
model
  schema 1.1

type user

type organization
  relations
    define owner: [user]
    define member: [user] or owner

type team
  relations
    define parent: [organization]
    define maintainer: [user]
    define member: [user, team#member] or maintainer

type repo
  relations
    define owner: [organization]
    define admin: [user, team#member]
    define writer: [user, team#member] or admin
    define reader: [user, team#member] or writer or member from owner
```

Save as `tests/fixtures/github.fga` (already in the repo) and load:

```sh
STORE_ID=$(curl -sS -X POST http://localhost:8080/stores \
  -H 'Content-Type: application/json' \
  -d '{"name":"github-recipe"}' | jq -r .id)

STORE_ID=$STORE_ID pnpm load-model tests/fixtures/github.fga
# prints OPENFGA_MODEL_ID=01HXYZ...
```

## Seed data

```sh
write_tuples() {
  curl -sS -X POST http://localhost:8080/stores/$STORE_ID/write \
    -H 'Content-Type: application/json' \
    -d "{ \"writes\": { \"tuple_keys\": $1 } }"
}

write_tuples '[
  { "user": "user:alice",                      "relation": "owner",      "object": "organization:acme" },
  { "user": "user:bob",                        "relation": "member",     "object": "organization:acme" },
  { "user": "user:carol",                      "relation": "member",     "object": "organization:acme" },
  { "user": "user:dave",                       "relation": "member",     "object": "organization:acme" },

  { "user": "organization:acme",               "relation": "parent",     "object": "team:acme-platform" },
  { "user": "user:bob",                        "relation": "maintainer", "object": "team:acme-platform" },
  { "user": "user:carol",                      "relation": "member",     "object": "team:acme-platform" },

  { "user": "organization:acme",               "relation": "owner",      "object": "repo:acme/api" },
  { "user": "team:acme-platform#member",       "relation": "writer",     "object": "repo:acme/api" },

  { "user": "organization:acme",               "relation": "owner",      "object": "repo:acme/public-docs" }
]'
```

## What this means

- **alice** is an org owner, so she's a member of `organization:acme`
  (via `member = [user] or owner`).
- **bob** is the platform-team maintainer, so he's also a team
  member (`member = [user, team#member] or maintainer`).
- **carol** is a direct team member.
- The platform team has write on `repo:acme/api` via
  `team:acme-platform#member` → `writer`.
- Everyone in the org reads `repo:acme/public-docs` via
  `reader = … or member from owner` — every org member is a reader.

## Sample checks

### Can bob write to repo:acme/api?

```sh
curl -sS -X POST http://localhost:8080/stores/$STORE_ID/check \
  -H 'Content-Type: application/json' \
  -d '{
    "tuple_key": { "user": "user:bob", "relation": "writer", "object": "repo:acme/api" }
  }'
# { "allowed": true }
```

Bob is a platform-team maintainer → team member → writer on the
repo via the team#member usertype.

### Can dave write to repo:acme/api?

```sh
curl -sS -X POST http://localhost:8080/stores/$STORE_ID/check \
  -H 'Content-Type: application/json' \
  -d '{
    "tuple_key": { "user": "user:dave", "relation": "writer", "object": "repo:acme/api" }
  }'
# { "allowed": false }
```

Dave is an org member but not on the platform team — only the
platform team has writer.

### Can dave read repo:acme/public-docs?

```sh
curl -sS -X POST http://localhost:8080/stores/$STORE_ID/check \
  -H 'Content-Type: application/json' \
  -d '{
    "tuple_key": { "user": "user:dave", "relation": "reader", "object": "repo:acme/public-docs" }
  }'
# { "allowed": true }
```

The repo is owned by the org; org members are readers via
`reader = … or member from owner`.

### Who can write to repo:acme/api?

```sh
curl -sS -X POST http://localhost:8080/stores/$STORE_ID/list-users \
  -H 'Content-Type: application/json' \
  -d '{
    "object":     { "type": "repo", "id": "acme/api" },
    "relation":   "writer",
    "user_filters": [{ "type": "user" }]
  }'
# { "users": [
#     { "object": { "type": "user", "id": "bob" } },
#     { "object": { "type": "user", "id": "carol" } }
# ]}
```

### Which repos can carol write to?

```sh
curl -sS -X POST http://localhost:8080/stores/$STORE_ID/list-objects \
  -H 'Content-Type: application/json' \
  -d '{
    "type":     "repo",
    "relation": "writer",
    "user":     "user:carol"
  }'
# { "objects": ["repo:acme/api"] }
```

## Adding a new repo

```sh
curl -sS -X POST http://localhost:8080/stores/$STORE_ID/write \
  -H 'Content-Type: application/json' \
  -d '{
    "writes": { "tuple_keys": [
      { "user": "organization:acme",          "relation": "owner",  "object": "repo:acme/billing" },
      { "user": "team:acme-platform#member",  "relation": "writer", "object": "repo:acme/billing" }
    ]}
  }'
```

The org-ownership tuple gives every org member read access via
`member from owner`. The team-write tuple gives platform-team
members write access.

## Variations

### Read-only access for a specific user

```sh
curl -sS -X POST http://localhost:8080/stores/$STORE_ID/write \
  -H 'Content-Type: application/json' \
  -d '{
    "writes": { "tuple_keys": [
      { "user": "user:eve", "relation": "reader", "object": "repo:acme/api" }
    ]}
  }'
```

Eve isn't in the org but has explicit reader access to one repo.

### Cross-team write

Add a second team and grant them write on a specific repo:

```sh
curl -sS -X POST http://localhost:8080/stores/$STORE_ID/write \
  -H 'Content-Type: application/json' \
  -d '{
    "writes": { "tuple_keys": [
      { "user": "organization:acme",     "relation": "parent",     "object": "team:acme-security" },
      { "user": "user:eve",              "relation": "maintainer", "object": "team:acme-security" },
      { "user": "team:acme-security#member", "relation": "writer", "object": "repo:acme/api" }
    ]}
  }'
```

Now both platform and security team members have write on
`repo:acme/api`.

## See also

- [First Authorization Check](/guide/first-check) — single-tuple
  primer
- [Document Sharing](/recipes/document-sharing) — folder-inherited
  access and group-of-groups expansion
