# Implementation and Handoff Summaries

When implementation is complete, provide a visible implementation summary before commit unless the user explicitly says not to.

This summary is mandatory for completed implementation work. It exists so the user can understand what changed before code review, commit, push, bead closure, or branch cleanup.

This summary does not replace any governance step, quality gate, pre-commit approval, commit/push requirement, evidence block, or bead state transition.

## Timing

- Deliver this summary after implementation is complete.
- Deliver it before commit when the user may review the implementation.
- Do not delay this summary until after the completion checklist.
- For multi-agent worker work, the required artifact is an orchestrator-facing
  handoff summary unless the user explicitly asks to review the worker slice
  directly.

## Required Summary Structure

For single-agent work and multi-agent orchestrator work, use the full user-
facing summary structure below.

For multi-agent worker work, a concise orchestrator-facing handoff summary is
sufficient. It MUST include:

1. `Bead`
   - Reference the worker bead id explicitly.
2. `Branch`
   - State the worker branch name and whether it was published.
   - Include the commit SHA handed to the orchestrator.
3. `Implementation Outcome`
   - State what changed in concrete terms.
   - Reference the intended integration target branch.
4. `Quality Gates`
   - Report the gates run and pass/fail status.
5. `Risks / Gaps`
   - State known issues, follow-ups, or unresolved concerns for integration.
6. `Review Notes`
   - State anything the orchestrator should pay attention to during integration.

## Full User-Facing Summary Structure

For single-agent work and multi-agent orchestrator work, use this structure:

1. **Process Used**
   - State whether the work followed the full bead process or the lightweight process.
   - If the lightweight process was used, state that explicitly.
   - State whether the work is single-agent, multi-agent worker work, or
     multi-agent orchestrator work.

2. **Bead Scope**
   - State which bead or beads were implemented or affected.
   - Reference each bead id explicitly.
   - If no bead was worked on, state `No bead was worked on.`

3. **Implementation Outcome**
   - State what was implemented or changed.
   - Reference the active branch name when a branch was used.
   - Reference the integration target branch when one exists.
   - Keep this concrete and scoped to actual delivered work.

4. **Behavioral Impact**
   - Describe the user-visible or system-visible effect of the change.
   - Note any migrations, config changes, or operational effects.

5. **Risks / Gaps**
   - List known limitations, follow-up work, edge cases not covered, or unresolved concerns.
   - If there are none, state `No known implementation gaps at handoff.`

6. **File Reference Summary**
   - Cite the primary files changed.
   - Do not dump a full changelog; include only the files most relevant to review.

7. **Governance Status**
   - State which completion steps are still pending.
   - State whether the work is awaiting orchestrator acceptance, awaiting
     merge to `develop`, or awaiting an approved PR from `develop` to `main`,
     when applicable.
   - If commit, push, quality gates, pre-commit approval, bead closure, or branch cleanup have not happened yet, say so explicitly.

## Hard Rules

- Do not treat this summary as evidence that completion checklist steps were executed.
- Do not imply commit, push, quality gate completion, or bead closure unless those steps actually happened.
- Do not withhold this summary solely because commit or closure has not happened yet.
- Do not require a user-facing implementation summary for a worker bead unless
  the user explicitly asks for one.
