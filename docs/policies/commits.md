# Commit Policy

## Conventional Commits

* Use Conventional Commits format.
* Format reference: https://www.conventionalcommits.org/en/v1.0.0/

## Commit Body Requirements

* Provide a thorough, multi-paragraph body that explains what changed and why.
* A short summary alone is insufficient.

## Co-Author Requirement

Always include:

```
Co-authored-by: {INPUT_MODEL_NAME_VERSION_HERE} <{MODEL_COMPANY_EMAIL}>
```

* Replace `INPUT_MODEL_NAME_VERSION_HERE` with the model name/version used to generate code (e.g., `gpt-5.2-codex-max`).
* Replace `MODEL_COMPANY_EMAIL` with the model email (e.g., `codex@openai.com`).

## Beads Traceability (Mandatory)

* Every commit MUST reference the Beads Issue ID it relates to.
* The Beads ID SHOULD appear in the commit subject (preferred) or body.
* Commits without a Beads reference are invalid and must be corrected before pushing.

## Missing Bead Handling

* Do not commit if no applicable Beads Issue exists.
* Inform the user and ask how to proceed.
* Default: create a miscellaneous Beads Issue describing the change and associate the commit with it.

## Pre-commit Approval

* If changes affect externally visible behavior, ask the user for approval **before any commit**.
* If approval is requested, do not commit or push until the user approves.
* Do not merge to `develop` or promote `develop` to `main` before approval is granted when approval is required.

## Amendments

* Never amend a commit unless explicitly requested by the user.

## Push/Merge Discipline

* Merge topology and authority are governed by
  `@docs/policies/branches-worktrees.md`. This section restates the
  key constraints for commit-time enforcement.
* Work is not complete until required pushes succeed.
* Never say “ready to push when you are.” If policy and approval allow a push, perform it.
* If push fails, resolve the issue and retry until it succeeds.
* After approval, publish the working branch when remote visibility is
  required and verify parity for any published branch.
* In multi-agent workloads, workers commit on their local `feature/*` branches
  for orchestrator review and do not merge those branches forward themselves.
* Worker `feature/*` branches remain local by default.
* Worker `feature/*` branches MUST be published when remote visibility is
  required for handoff, recovery posture, CI, branch-level review, or explicit
  user-requested auditability. See
  `@docs/policies/branches-worktrees.md` Section 7 for the detailed
  publication conditions.
* In multi-agent workloads, only the orchestrator may accept worker branches
  into the coordinated integration branch.
* The orchestrator MUST publish the coordinated `integration/*` branch when it
  is the shared integration target, and any branch proposed for PR review MUST
  be published.
* For single-agent work, merge the `feature/*` branch into `develop`.
* For epic work, merge accepted worker `feature/*` branches into the epic
  `integration/*` branch, then merge the epic `integration/*` branch into
  `develop`.
* Never merge a `feature/*` branch directly to `main`.
* Never merge an epic `integration/*` branch directly to `main`.
* `main` only receives changes from an approved PR whose source branch is
  `develop`, unless the user explicitly approves an exception.
* Do not treat ordinary bead closure as permission to promote `develop` to
  `main`.
* Report final branch cleanup status.

## Merge Commit Messages

* Merge commits MAY use the default message produced by Git.
* This is the only exception to the Conventional Commits and Beads ID requirements for commit messages.
