# Closeout Summaries

After completing the required implementation and closure steps, provide a final visible closeout summary to the user.

This summary is mandatory, but it does not replace any governance step, evidence block, quality gate, pre-commit approval, commit/push requirement, or bead state transition.

## Timing

This summary must be delivered after the applicable process has been executed:

- Full bead process: only after the completion checklist and any required branch cleanup steps.
- Lightweight process: only after the approved lightweight work is complete and after any applicable closeout steps.
- Multi-agent orchestrator work: only after the required integration branch
  reaches `develop` and the applicable cleanup steps are complete.

Multi-agent worker work does not require a separate user-facing closeout summary
by default. The worker's required summary artifact is the orchestrator-facing
handoff summary delivered before orchestrator review.

The orchestrator incorporates accepted worker output into the overall external
closeout summary for the coordinated workload unless the user explicitly
requests per-worker closeout reporting.

## Required Closeout Summary Structure

1. **Process Used**
   - State whether the work followed the full bead process or the lightweight process.
   - State whether the work is single-agent, multi-agent worker work, or
     multi-agent orchestrator work.

2. **Bead Scope**
   - State which bead or beads were implemented or affected.
   - Reference each bead id explicitly.
   - If no bead was worked on, state `No bead was worked on.`

3. **Closeout Outcome**
   - State what was delivered and closed out.
   - Reference the active branch name when a branch was used.
   - Reference the integration target branch reached at closeout.
   - Keep this concrete and scoped to actual delivered work.

4. **Evidence**
   - Report quality gate results exactly as executed.
   - State whether pre-commit approval was offered, requested, performed, or deferred.
   - State commit SHA, push status, and branch status when those steps applied.
   - State whether the work stopped at orchestrator handoff, reached an epic
     integration branch, reached `develop`, or was promoted to a PR from
     `develop` to `main`, when applicable.
   - If any required step was not completed, say so plainly and keep the bead `in_progress` when a bead is in scope.

5. **Behavioral Impact**
   - Describe the user-visible or system-visible effect of the change.
   - Note any migrations, config changes, operational effects, or rollout concerns.

6. **Risks / Gaps**
   - List any known limitations, follow-up work, edge cases not covered, or unresolved concerns.
   - If there are none, state `No known remaining gaps at closeout.`

7. **File Reference Summary**
   - Cite the primary files changed.
   - Do not dump a full changelog; include only the files most relevant to review or future maintenance.

## Hard Rules

- Do not claim completion without matching evidence.
- Do not use the closeout summary to hide failed checks, skipped steps, or unresolved governance requirements.
- Do not mark work "done" if the bead remains open or required closure steps failed.
- If implementation is complete but closure is blocked, summarize the implementation separately from the blocked governance step.
- Do not omit process type, bead scope, or explicit no-bead status.

## Preferred Tone

- Factual, concise, externally legible.
- No motivational language, no self-congratulation, no vague claims.
- Optimize for fast verification by the user.
