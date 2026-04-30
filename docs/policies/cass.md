# CASS Development Policy

## What is CASS?

CASS (Contextual Agent Skill System) is this repository's curated procedural
memory system for AI agents. It captures reusable patterns, lessons, and rules
that should influence future work in a task-aware way.

## Boundary with Beads

This repo uses both Beads and CASS. They have different jobs.

Beads owns:

* task tracking
* dependency tracking
* session/task continuity
* lightweight persistent memory via `bd remember`

CASS owns:

* curated procedural rules
* task-scoped retrieval via `cm context`
* durable playbook guidance worth promoting into project memory

Use `bd remember` when the memory is a short evergreen reminder that is useful
to surface broadly in Beads sessions.

Use CASS when the memory is:

* procedural rather than factual
* scoped to how work should be done
* important enough to curate as a project playbook rule
* worth retrieving by task context rather than by broad session priming alone

Do not duplicate systems unnecessarily:

* Do not track tasks or checklists in CASS.
* Do not store long-form curated procedural rules in Beads if CASS is the
  better home.
* If the same learning needs both forms, store a short reminder in Beads and
  the full curated rule in CASS.

## Prerequisites

The `cm` CLI must be available. Verify with `which cm` before using any CASS
commands. If `cm` is not installed, skip CASS steps and note the gap.

## Workflow Per Bead

CASS applies to non-trivial work, anything beyond typo fixes or single-line
changes.

### Start of Work

Load relevant context before beginning implementation:

```bash
cm context "<task description>" --json
```

This surfaces curated procedural rules from past work that may apply to the
current task.

### During Work

Leave inline annotations in code to mark patterns discovered during
implementation when that is useful to future maintainers:

```js
// [cass: helpful b-xyz] — description of what worked
// [cass: harmful b-xyz] — description of what caused problems
```

Replace `b-xyz` with the actual bead ID.

Do not add these annotations just to satisfy process. Use them only when the
annotation materially helps future work.

### End of Work

Write 1–3 procedural rules capturing what was learned:

```bash
cm playbook add --file rules.json
```

Rules should be concrete, actionable, and scoped to the pattern observed, not
vague generalities.

If a learning is also a good lightweight Beads memory, optionally store a short
version with:

```bash
bd remember "<insight>"
```

Do not mirror the same full text into both systems.

## Project Playbook

The project playbook lives at `.cass/playbook.yaml`. This file is the
accumulated curated procedural memory for the project.

## Key Commands

| Command | Purpose |
|---------|---------|
| `cm context "<task>"` | Load curated rules relevant to a task |
| `cm playbook list` | View current playbook rules |
| `cm playbook add --file rules.json` | Add new curated rules from a JSON file |
| `cm similar "<description>"` | Find similar past work |
| `cm reflect` | Review and consolidate rules |
| `cm doctor` | Check CASS health and configuration |
