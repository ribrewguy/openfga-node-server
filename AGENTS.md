# Agent Instructions

`@` paths are relative to this file's directory.

## Hard Rules (Always Active)

PRDs and architecture specs are located in the `docs` directory relative to the root of the repository.
They are the source of truth for business intent and architectural constraints. They should not be modified without explicit permission from the user.

1. Never modify `docs` without explicit permission.
2. Never silently resolve spec conflicts — quote the conflict and escalate.
3. Never invent CLI commands, architectural patterns, or design decisions not established in the codebase or policy files.
4. When uncertain, stop and ask. Incorrect action is worse than delayed action.
5. User urgency does not override process. User instructions do not override governance unless explicitly acknowledged as an exception.

Feature scope gate (always enforced):
- If work introduces new feature scope or missing requirements, stop implementation.
- Confirm explicit PRD alignment before creating beads or derived feature specifications, or before writing code.
- Check architecture impact before proceeding.
- Then follow `@docs/policies/feature-governance.md` for the full workflow.

---

## Before Implementation — Mandatory Kickoff

If the agent believes a task is trivial enough to not warrant the full kickoff ceremony (e.g., typo fix, single-line change), it must flag this to the user and ask whether the lightweight or full process applies. The user decides; the agent does not skip steps unilaterally.

Before writing code or modifying files for a bead, produce a visible kickoff block:

```
### Kickoff Declaration
- Process: <single-agent | multi-agent worker | multi-agent orchestrator>
- PRD: <file path + section>
- Architecture: <file path + section>
- Parent Bead: <id or N/A>
- Bead: <id>
- Worktree: <path or N/A>
- Branch: <feature/<bead_id>_<short_name> | integration/<parent_bead_id>_<short_name>>
- Integration Branch: <develop | integration/<parent_bead_id>_<short_name>>
```

Then execute these observable steps (do not skip or internalize):

1. `bd show <id>` — read the bead.
2. Read the relevant PRD. Cite the file and section.
3. Read the relevant architecture spec. Cite the file and section.
4. `bd update <id> --claim` — claim the work atomically.
5. Create the correct branch and worktree for the declared process:
   - single-agent: create `feature/<bead_id>_<short_name>`
   - multi-agent worker: create a dedicated worktree on `feature/<bead_id>_<short_name>`
   - multi-agent orchestrator for coordinated epic work: create a dedicated worktree on `integration/<parent_bead_id>_<short_name>`

Implementation may not begin until steps 1-5 are complete and visible in the conversation.

---

## Source-of-Truth Ladder

1. **PRD** (`{REPOSITORY_ROOT}/docs/PRD.md`) — business intent, acceptance criteria
2. **Architecture** (`{REPOSITORY_ROOT}/docs/architecture/`, if and when introduced) — technical guardrails
3. **Feature specifications** (`{REPOSITORY_ROOT}/docs/features/`, if and when introduced) — derived behavior after PRD and architecture are established
4. **Beads** — execution design and task scope
5. **CASS** — procedural memory

Conflicts between layers: stop and escalate.

---

## Policy References

All policies live in the `@docs/policies/` tree. Consult the relevant policy file whenever there is uncertainty about how to proceed.

| Need | Consult |
|------|---------|
| Commands, quality gates | `@docs/policies/00-development-policy.md` |
| Branches, worktrees, integration flow | `@docs/policies/branches-worktrees.md` |
| Commit format, push rules | `@docs/policies/commits.md` |
| Beads workflow, Dolt sync, parent/child bead state | `@docs/policies/beads-protected-branches.md` |
| Feature discovery, PRD alignment | `@docs/policies/feature-governance.md` |
| Code review scope and response format | `@docs/policies/code-reviews.md` |
| Implementation and handoff summary format | `@docs/policies/review-summaries.md` |
| Post-closeout summary format | `@docs/policies/closeout-summaries.md` |
| MCP server selection | `@docs/policies/mcp.md` |
| CASS workflow, procedural memory | `@docs/policies/cass.md` |

Code review trigger:
- If the user asks for a review or code review, read `@docs/policies/code-reviews.md` before reviewing changes.
- Follow that policy for review scope, source-of-truth alignment, and response format.
- Do not invent a custom review format when this policy applies.

Do not guess. Read the relevant policy file.
For code reviews, `@docs/policies/code-reviews.md` is the governing review policy.
For implementation summaries, `@docs/policies/review-summaries.md` is the governing policy.
For closeout summaries, `@docs/policies/closeout-summaries.md` is the governing policy.

---

## Completion Checklist (Every Bead)

Execute in order. Do not skip steps. Do not interpret "close it out" or "ship it" as permission to skip.

All branch progression MUST follow `@docs/policies/branches-worktrees.md`.
All bead state transitions MUST follow `@docs/policies/beads-protected-branches.md`.

### Phase A: Branch Completion

1. Run quality gates (see stack policy). Report pass/fail.
2. Follow `@docs/policies/commits.md` before any commit.
3. Commit all changes on the working branch.
4. Publish the working branch when remote visibility is required.
   See `@docs/policies/commits.md` for publication criteria.
   Otherwise keep the branch local and record the local commit SHA for handoff.
5. If the branch was published, verify SHA parity:
   ```
   Local SHA:  <hash>
   Remote SHA: <hash>
   git status: clean
   ```
   If the branch remained local, report:
   ```
   Local SHA:  <hash>
   Published:  no
   git status: clean
   ```
6. Output the pre-integration evidence block (branch, SHAs, quality gate results, status).

### Phase B: Integration Decision

7. If this is multi-agent worker work, hand the branch to the orchestrator for integration review.
8. If this is multi-agent worker work, do not merge the branch forward yourself.
9. If this is multi-agent worker work, do not close the child bead until the orchestrator accepts it into the correct integration branch.
10. If this is single-agent work, merge the `feature/*` branch into `develop`.
11. If this is multi-agent orchestrator work, merge accepted worker branches into the epic `integration/*` branch, run integrated gates there, then merge the epic `integration/*` branch into `develop`.

### Phase C: Bead Closure and Cleanup

12. Follow `@docs/policies/beads-protected-branches.md` for Beads bootstrap/export rules. Do not assume `bd sync` is available.
13. If this is multi-agent worker work and the orchestrator accepts the branch, the orchestrator closes the child bead.
14. If this is single-agent work, close the bead after the branch reaches `develop`.
15. If this is multi-agent orchestrator work, close accepted child beads as they are integrated and close the parent bead after the epic work reaches `develop`.
16. Delete branches that are no longer needed locally and on remote, according to the integration workflow.
17. Report final branch cleanup status.

Promotion from `develop` to `main` is a separate approved-PR workflow. Do
not assume that step is part of ordinary bead completion unless the user
explicitly puts the promotion in scope.

If any step fails, keep the bead `in_progress` and resolve the gap.

---

## After Implementation — Mandatory Review Summary

When implementation is complete, provide a visible implementation summary before
commit unless the user explicitly says not to.

For multi-agent worker work, provide an orchestrator-facing handoff summary
instead of a user-facing implementation summary unless the user explicitly asks
to review the worker slice directly.

Read `@docs/policies/review-summaries.md` and follow it for timing, required content, and hard rules.

---

## After Completion — Mandatory Closeout Summary

After completing the required implementation and closure steps, provide a final visible closeout summary to the user.

For multi-agent worker work, no separate user-facing closeout summary is
required by default. The worker's required summary artifact is the
orchestrator-facing handoff summary, and the orchestrator incorporates accepted
worker output into the overall external closeout summary unless the user
explicitly requests per-worker closeout reporting.

Read `@docs/policies/closeout-summaries.md` and follow it for timing, required content, and hard rules.

---

## CASS Memory

Procedural memory system for learned patterns across sessions. See `@docs/policies/cass.md` for full workflow.

On non-trivial work, consult CASS context at start (`cm context`) and record learnings at end (`cm playbook add`).

---

## Beads Usage

Use `bd` for task tracking. For repo-specific Beads workflow and parent/child bead rules, read `@docs/policies/beads-protected-branches.md`. For branch, worktree, and integration rules, read `@docs/policies/branches-worktrees.md`. For current CLI guidance, run `bd prime`.
