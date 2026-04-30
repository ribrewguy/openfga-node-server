## Code Review — Mandatory Response Format

When the user asks for a code review, default to a review-only mindset unless they explicitly ask for fixes. The review must verify that the
implementation aligns with the governing sources of truth that are actually in scope for the work.

Source-of-truth review order:
1. Bead scope, if a bead exists
2. Bead design, if present
3. Architecture spec(s), if applicable
4. Feature specification(s), if applicable
5. PRD(s), if applicable
6. Lightweight-process context, if no bead exists

Do not review only for code quality in isolation. Review for correctness against scope, intent, constraints, and acceptance criteria.

### Required preparation

Before writing findings, the agent must determine and state:

- Whether the review is tied to a bead
- Whether the work appears to have used the lightweight process
- Whether the work is single-agent, multi-agent worker work, or
  multi-agent orchestrator work
- Which branch and integration target are in scope, if they can be determined
- Which governing documents were consulted
- Which governing documents were not available or not applicable

If a bead is identified:
- State the bead id.
- Review against the bead scope and bead design if available.

If no bead is identified:
- State that explicitly.
- State whether the work appears to be lightweight-process work or unattributed branch work.
- Do not invent a bead.
- Review against the best available governing sources: architecture, feature specifications, PRDs, and local task context.

### Required output format

Every code review response must start with exactly:

`Findings:`

Then use this structure, in this order:

1. `Review Scope: Bead <id>` or `Review Scope: No bead identified`
2. `Process Context: Full bead process` or `Process Context: Lightweight process` or `Process Context: Unable to determine`
3. `Execution Context: Single-agent` or `Execution Context: Multi-agent worker` or `Execution Context: Multi-agent orchestrator` or `Execution Context: Unable to determine`
4. `Integration Target: <branch name or "Unable to determine">`
5. `Design Reference: <summary or "None found" or "No bead identified">`
6. `Architecture Reference: <file path + section, or "None applicable">`
7. `Feature Specification Reference: <file path + section, or "None applicable">`
8. `PRD Reference: <file path + section, or "None applicable">`

Then list findings ordered by severity.

Each finding must:
- Start with severity: `High`, `Medium`, or `Low`
- State the issue in one sentence
- Explain why it violates or risks violating the scoped source of truth
- Include precise file references with line numbers
- Name the source of truth used for the finding
- Propose a fix that would align the implementation with the source of truth

Format each finding like this:

- `High` [path/to/file.ext:line]
  Problem: <what is wrong>
  Why it matters: <behavioral, governance, architectural, or product impact>
  Source of truth: <bead / design / architecture / feature specification / PRD / lightweight task context>
  Proposed fix: <what needs to change to align with the source of truth>

### No-findings case

If no findings are discovered, still begin with:

`Findings:`

Then output:

- `Review Scope: <...>`
- `Process Context: <...>`
- `Execution Context: <...>`
- `Integration Target: <...>`
- `Design Reference: <...>`
- `Architecture Reference: <...>`
- `Feature Specification Reference: <...>`
- `PRD Reference: <...>`
- `No findings.`

Then add:
- `Residual Risks / Gaps: <tests not run, unclear assumptions, missing docs, or "None noted">`

### Hard rules

- Findings must come before summaries or change overviews.
- Do not invent a bead when none exists.
- Do not omit review-scope reporting; explicitly state when no bead was identified.
- If no bead exists, explicitly review against lightweight-process context and the highest available source-of-truth documents.
- Do not omit design alignment analysis when a bead design exists.
- Do not silently skip architecture, feature specification, or PRD checks; state when they are not applicable.
- If required sources are missing, say so under `Residual Risks / Gaps`.
