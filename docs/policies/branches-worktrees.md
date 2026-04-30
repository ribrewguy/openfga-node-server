# Branches, Worktrees, and Integration Policy

This policy governs Git branches, Git worktrees, integration branches, and
merge authority for this repository.

Beads lifecycle and Dolt-backed task tracking are governed separately by
`@docs/policies/beads-protected-branches.md`.

## 1. Branch Hierarchy

This repository uses the following long-lived branches:

* `main` - production / release branch
* `develop` - long-lived integration branch for staging and review

All implementation branches MUST eventually flow through `develop` before
an approved PR may merge `develop` into `main`.

Do not merge any `feature/*` branch directly to `main`.
Do not merge any epic integration branch directly to `main`.

`main` only receives changes from an approved PR whose source branch is
`develop`, unless the user explicitly approves a hotfix exception.

## 2. Branch Types

Use these branch types:

* `feature/<bead_id>_<short_name>` - implementation branch for a single bead
* `integration/<bead_id>_<short_name>` - intermediate integration branch for an
  epic or other coordinated multi-agent parent bead
* `develop` - repo-wide integration branch

One implementation bead maps to one `feature/*` branch.
One coordinated parent bead maps to one `integration/*` branch when the work is
split across multiple worker beads under a shared epic.

## 3. Worktree Requirements

Multi-agent workloads MUST use Git worktrees.

For any multi-agent workload, each implementation agent MUST have:

* an assigned bead
* a dedicated `feature/*` branch for that bead
* a dedicated Git worktree checked out to that branch

Do not run multiple implementation agents in the same worktree.
Do not assign multiple worker beads to the same `feature/*` branch.

Single-agent work MAY use a standard checkout or a dedicated worktree.
Multi-agent work MUST use dedicated worktrees.

This policy does not mandate a specific filesystem location for worktrees.
If the user or repo tooling does not specify a path convention, choose any
location that keeps worktrees outside each other and outside generated output.

## 4. Multi-Agent Roles

A multi-agent workload exists when more than one implementation agent contributes
code or policy changes to the same deliverable.

Every multi-agent workload MUST have exactly one orchestrator.

Unless the user explicitly assigns a different owner, the top-level agent that
starts the multi-agent workload is the orchestrator by default.

Workers MUST assume they are not the orchestrator unless the governing bead,
kickoff declaration, or user instruction explicitly says otherwise.

The orchestrator may resolve merge conflicts and make integration-only changes
on the `integration/*` branch.

The orchestrator MUST NOT implement worker-scoped functionality on the
`integration/*` branch unless ownership is explicitly reassigned or a new bead
is created for that work.

## 5. Integration Targets

Use these default integration targets:

* Single-agent work: merge the `feature/*` branch into `develop`
* Multi-agent epic work: merge worker `feature/*` branches into the parent
  `integration/*` branch, then merge the `integration/*` branch into `develop`

If the user designates a different intermediate integration branch for a
coordinated workload, that exception must be explicit in the bead DESIGN or in
the user's instructions.

`develop` remains the required long-lived integration branch in all normal
cases.

## 6. Merge Authority

Only the orchestrator may accept worker output into the coordinated integration
branch.

Workers MUST NOT merge their own `feature/*` branches into:

* another worker branch
* an epic `integration/*` branch
* `develop`
* `main`

For single-agent work, the implementing agent is also the integrator for that
single branch and may merge the `feature/*` branch into `develop` after all
governance requirements pass.

Only work that has already reached `develop` may be proposed for `main`.

## 7. Acceptance and Rejection

When a worker branch is ready, the worker hands it to the orchestrator for
integration review.

The worker branch remains local by default when the orchestrator can access it
through the same repository and worktree set.

The worker branch MUST be published when:

* the orchestrator needs remote access to the branch
* CI or branch-level review is required on that branch
* the user explicitly requires remote branch visibility or auditability
* the team needs a remote recovery point before integration

The orchestrator is responsible for:

* attempting the merge into the integration branch
* resolving integration order
* running required integrated quality gates
* verifying alignment with bead design, architecture, and PRD scope
* accepting the branch or rejecting it back to the responsible worker

The orchestrator MUST reject a worker branch when integration fails because of:

* merge conflicts
* failing tests or other failing required gates
* syntax, typecheck, build, or lint errors that violate required gates
* divergence from the bead design
* divergence from architecture or PRD constraints

The orchestrator MUST return rejection feedback as explicit notes to the worker.
Do not silently fix worker-owned defects unless the user explicitly reassigns
ownership or approves the orchestrator taking over that slice.

## 8. Promotion Flow

The required promotion flow is:

* worker `feature/*` branch -> epic `integration/*` branch -> `develop` -> approved PR to `main`
* single-agent `feature/*` branch -> `develop` -> approved PR to `main`

Only branches that act as shared integration or PR review surfaces are required
to be published to remote by default. Local worker `feature/*` branches may stay
local unless Section 7 requires publication.

Branch cleanup and bead closure MUST respect the integration target that applies
to the work.

Do not treat ordinary bead completion as permission to promote `develop` to
`main`. Promotion from `develop` to `main` requires explicit approval and a PR
review step.

## 9. Close-Out Rules

Worker close-out ends at orchestrator acceptance into the correct integration
branch. It does not include merging to `develop` or `main`.

The worker is responsible for the implementation summary or handoff summary that
precedes orchestrator review.

The orchestrator is responsible for incorporating accepted child work into the
coordinated external closeout summary, not for producing a separate per-child
closeout unless the user explicitly requests per-child reporting.

Orchestrator close-out for epic work ends after:

* accepted worker branches are merged into the epic `integration/*` branch
* integrated gates pass on the epic integration branch
* the epic integration branch is merged into `develop`
* the related branch cleanup steps are complete

Single-agent close-out ends after:

* the `feature/*` branch is merged into `develop`
* the related branch cleanup steps are complete

After branch cleanup, remove dedicated worktrees that are no longer needed.
Do not leave stale multi-agent worktrees behind.

Branch cleanup means:

* verify the branch has been fully merged into its integration target
* delete the local branch
* delete the remote branch if it was published

The orchestrator is responsible for deleting accepted worker `feature/*`
branches during cleanup, both locally and on remote when those branches were
published.

Promotion from `develop` to `main` is a separate release activity unless the
user explicitly puts that release activity in scope.
