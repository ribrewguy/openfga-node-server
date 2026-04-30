# Feature Discovery & Governance Policy

This policy governs how new features, capabilities, and requirements are introduced into the codebase. It applies to all agents and is referenced from CLAUDE.md and AGENTS.md.

---

## 1. Discovery Before Creation

When a new feature or missing requirement is identified during development:

1. Clarify the goal with the user.
2. Confirm the business intent.
3. Check whether the capability already exists in an existing PRD, architecture spec, or feature specification.
4. If ambiguous, ask questions before creating any artifact.

Do not create beads, feature specifications, or other artifacts without completing these steps.

---

## 2. PRD Alignment Gate

A new feature must not enter execution unless one of:

- A relevant PRD already exists.
- The feature is explicitly added to an existing PRD (with permission).
- A new PRD is created (with permission).

Features without business intent are invalid work. Stop and escalate.

---

## 3. Architecture Awareness Check

Evaluate whether the feature has architectural implications. If likely:

- Confirm constraints with the user.
- Propose architecture considerations.
- Ask whether architecture documentation should be updated.

Never assume architectural freedom.

---

## 4. Artifact Creation Order

When introducing a new capability, follow this order strictly:

1. Align with PRD.
2. Confirm architecture impact.
3. Create or update a feature specification (if applicable).
4. Create the Epic/Bead with DESIGN.

Do not reverse this order.

---

## 5. Epic DESIGN Requirement

Every epic bead must include a DESIGN section containing:

- Business intent (PRD reference)
- Architectural considerations
- Proposed behavior
- Acceptance signals
- Execution topology when the work will be parallelized across multiple agents:
  - parent bead ownership
  - child bead boundaries
  - orchestrator ownership
  - integration branch target
  - acceptance and rejection criteria for child branch integration

Beads without DESIGN are incomplete.

---

## 6. Broader Impact Detection

Alert the user if the feature suggests:

- A cross-cutting concern or systemic behavior
- Security implications or data model changes
- Provenance requirements or platform capabilities

When detected, recommend whether a higher-level PRD or architectural addition is more appropriate than a narrow feature.

---

## 7. Conflict & Escalation

If PRDs, architecture, feature specifications, beads, or user requests conflict:

1. Stop implementation.
2. Quote the conflicting sections (file + heading).
3. Explain the impact.
4. Provide 1-3 resolution options.
5. Ask the user to choose.

No silent reinterpretation. No temporary exceptions.

---

## 8. Editing PRDs and Architecture

The PRD lives at `docs/PRD.md` relative to the repository root. Architecture specs (`docs/architecture/`) and feature specifications (`docs/features/`) are not yet introduced for this repo; if added, they live under those directories.
These documents are the source of truth for business intent and architectural constraints, and they should not be modified without explicit permission from the user.
Ask permission before modifying these documents.

Confirm:
- What is changing.
- Why it is changing.
- Whether broader impact suggests a larger refactor.

If broader impact is likely, recommend follow-up epics instead of bundling silently.

---

## 9. Spike Mode

Allowed only with explicit user approval. Spike mode:

- Is time-boxed.
- Does not weaken PRDs or architecture.
- Produces recommendations folded into epic DESIGN.
