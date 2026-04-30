# Development Policies (00-development-policy.md)

This document defines **high-level, reusable project-wide development rules**.

It intentionally stays minimal and defers detailed enforcement to the
cross-cutting policies listed in §3.

All agents must comply strictly. No deviations without updating this policy.

---

## 1. Policy Scope

This document applies to all development activities in this repository.
Project-specific policies live under `docs/policies/` relative to the repository root.

---

## 2. Root-Level Command Requirement

All required quality gates must be executable from the repository root.

The canonical commands for this project are defined in `package.json`
(`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:unit`,
`pnpm test:integration`, `pnpm build`).

Agents must not invent or assume commands.

---

## 3. Cross-Cutting Governance

Agents must respect:

* `@docs/policies/branches-worktrees.md`
* `@docs/policies/beads-protected-branches.md`
* `@docs/policies/cass.md`
* `@docs/policies/code-reviews.md`
* `@docs/policies/closeout-summaries.md`
* `@docs/policies/commits.md`
* `@docs/policies/feature-governance.md`
* `@docs/policies/mcp.md`
* `@docs/policies/review-summaries.md`

As used in these documents, `@` means "resolve the path relative to the document that references it." Unscoped paths may otherwise be interpreted relative to the current execution context.

Process compliance is mandatory.

---

## 4. CI Requirements

CI must enforce the quality gates defined in §2.

If CI behavior changes, update this file.

---

## 5. Absolute Rules

* No bypassing quality gates
* No committing secrets
* No direct modification of production infrastructure outside defined tooling
* No silent exception swallowing
* No architectural improvisation outside PRDs and architecture specs

This is a production-grade policy platform. Agents must treat it accordingly.
