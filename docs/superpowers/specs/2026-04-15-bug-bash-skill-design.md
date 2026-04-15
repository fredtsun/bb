# Bug Bash Skill — Design Spec (DRAFT)

**Status**: DRAFT COMPLETE — all sections approved; awaiting user spec review.
**Date**: 2026-04-15
**Author**: Fred (via brainstorming with Dragonite)

---

## Summary

`bb` is a Claude Code plugin that runs end-to-end "bug bashes" — a structured workflow from context ingestion through agent-driven testing to a final report. It ships two slash commands (`/bb:run` and `/bb:integration`), a pluggable connector system for ingesting context from arbitrary sources (JIRA, Google Docs, code, pasted text, URLs, custom), and a catalog of tester-agent prompt templates (browser, API, CLI, generic). The workflow is human-gated at every phase boundary, uses subagents aggressively to keep the main orchestrator lean, and persists all state to `.bb/<slug>/` so bashes survive `/clear` and session loss.

---

## 1. Top-level shape

### Two commands, bundled as plugin `bb`

#### `/bb:run` — guided bug bash workflow
Single entry point. Drives a six-phase flow. With no args, resumes any active bash; with description, starts a new one.

| # | Phase | Artifact | Gate |
|---|-------|----------|------|
| 1 | **Ingest** — pick connectors, pull context | `context.md` | Human: context good enough? |
| 2 | **Setup** — env, auth, shared preconditions | `setup.md` | Human: env actually ready? |
| 3 | **Define** — criteria + iterative scenarios | `scenarios.md` | Human: scenario list locked? |
| 4 | **Plan** — adaptive dispatch proposal | `dispatch-plan.md` | Human: methodology approved? |
| 5 | **Execute** — dispatch agents, rich findings | `findings/*.md` | Agents complete or halted |
| 6 | **Retest + Report** — human-gated retest loop → report | `retest-log.md`, `report.md` | Human: bash complete? |

Backtracking is available at every phase boundary. Downstream artifacts archive to `.history/<timestamp>/` on backtrack (never deleted).

#### `/bb:integration` — connector install & authoring
Separate one-off flow for:
- Browsing available connectors (catalog)
- Installing a known connector (walks MCP setup, auth, config)
- Authoring a custom connector (scaffolds `connectors/<name>/<name>.md` following the connector contract)
- Testing a connector end-to-end

### `AskUserQuestion` for structured multi-choice moments
- Ingest: which connectors to use (multi-select)
- Define: per-scenario action (keep / edit / drop / split)
- Plan: dispatch approval (approve / modify / cancel)
- Retest: per-finding disposition (fix-and-retest / mark-known / refine-criteria / skip)
- Integration: install type (browse / known / custom), "test now?"

Open-ended content (describe criteria, refine scenario wording) stays conversational.

### Rich findings always, never binary
Every scenario result is a rich finding: title, severity, repro steps, expected vs actual, evidence (logs, screenshots, error output). Retest is first-class and human-driven with skill-proposed suggestions.

### Standalone
No dependency on GSD, superpowers, or any other skill/plugin beyond Claude Code itself.

---

## 2. Directory layout

### Plugin source (`/Users/fredsun/Code/bb`)

```
bb/
├── plugin.json
├── commands/
│   ├── run.md                       # /bb:run orchestrator
│   └── integration.md               # /bb:integration orchestrator
├── connectors/
│   ├── integrations.md              # ← manifest: one-line entry per connector
│   ├── README.md                    # connector contract
│   ├── paste/paste.md
│   ├── url/url.md
│   ├── code/code.md
│   ├── jira/jira.md
│   └── gdocs/gdocs.md
├── agents/
│   ├── agents.md                    # ← manifest: one-line entry per agent type
│   ├── README.md                    # agent prompt contract
│   ├── browser/browser.md
│   ├── api/api.md
│   ├── cli/cli.md
│   └── generic/generic.md
├── templates/
│   ├── context.md
│   ├── setup.md
│   ├── scenario.md
│   ├── dispatch-plan.md
│   ├── finding.md
│   ├── pause-reminder.md
│   └── report.md
└── references/
    ├── workflow-phases.md
    ├── setup-playbook.md
    ├── dispatch-playbook.md
    ├── retest-playbook.md
    └── writing-connectors.md
```

**Manifest pattern**: `integrations.md` and `agents.md` are tiny tables. The orchestrator reads only the manifest at startup, then Reads a specific detail file only when that item is actually selected. Prevents context pollution when many connectors/agents are installed.

### Runtime state (user's project)

```
<user-project>/.bb/
├── INDEX.md                                 # auto-regenerated table of all bashes
├── auth-feature-2026-04-15/
│   ├── bash.json                            # structured metadata
│   ├── STATUS.md                            # narrative state + "exact next action"
│   ├── context.md                           # Phase 1
│   ├── setup.md                             # Phase 2
│   ├── scenarios.md                         # Phase 3
│   ├── dispatch-plan.md                     # Phase 4
│   ├── findings/                            # Phase 5
│   │   ├── F001-login-blank.md
│   │   └── F002-403-on-refresh.md
│   ├── retest-log.md                        # Phase 6 ongoing
│   ├── report.md                            # Phase 6 final
│   └── .history/<timestamp>/…               # backtrack archive
└── archive/                                 # completed/abandoned bashes move here
```

### `bash.json` fields
`slug`, `title`, `created_at`, `current_phase` (`ingest|setup|define|plan|execute|retest|complete`), `status` (`active|paused|complete|abandoned`), `connectors_used`, `dispatch_summary`, `finding_counts` (`open`, `resolved`, `known`), `retest_cycles`.

### `STATUS.md` — living narrative resume anchor
Human-readable, overwritten continuously:

- **Phase**: current phase name
- **Status**: one-line ("Active — awaiting human input on S07")
- **Where we left off**: narrative
- **Exact next action on resume**: literal instruction for the resuming orchestrator
- **Phase progress**: checkbox list
- **Pending decisions / subagent runs**: any in-flight work
- **Recent events**: short timestamped log

**Update cadence (write-through)**: orchestrator writes `STATUS.md` before AND after every significant action — before spawning a subagent, after a subagent returns, after every `AskUserQuestion` response, before emitting any pause reminder, on every phase transition. Worst-case data loss window is one atomic step.

Only the main orchestrator writes `STATUS.md`. Subagents write only their own artifact.

### Pause reminders at every phase boundary

Template at `templates/pause-reminder.md`:

```
─────────────────────────────────────
✓ Phase complete: {phase_name}
  Artifact saved: .bb/{slug}/{artifact_file}
  Next phase: {next_phase_name}

Running low on context?
  1. Run `/clear` — state is safe in .bb/{slug}/
  2. Return with `/bb:run`
  3. I auto-detect active bash and resume at {next_phase_name}

Continue, pause, or backtrack?
─────────────────────────────────────
```

Loudest reminders after Ingest (heavy reads) and Execute (many agent outputs).

### Resume mechanics

`/bb:run` with no args:
1. Scans `.bb/*/bash.json` for `status: active`
2. If one → Reads that bash's `STATUS.md`, announces "Resuming `{slug}`. Last action: {exact next action}. Continue?"
3. If many → `AskUserQuestion` picker
4. If none → start new bash

Orchestrator picks up from the literal "exact next action" in `STATUS.md`, not a guess at phase state.

---

## 2.5. Orchestrator-vs-subagent split

**Core rule**: main `/bb:run` orchestrator is a lean conversation manager. Any work involving heavy reads, synthesis, or generation gets delegated to a subagent that returns a compact artifact. Main session touches the artifact file, never the raw inputs.

### When to spawn subagents

| Phase | Subagent role | Trigger | Returns |
|-------|--------------|---------|---------|
| Ingest | One per selected connector, parallel | ≥1 connector picked | Compressed summary → appended to `context.md` |
| Setup | "Infer from repo" agent | User picks "infer" | Draft `setup.md` from `.env.example`, compose files, README, package scripts |
| Define | "Draft scenarios" agent | After context + setup exist | Structured scenario list → seeds `scenarios.md` |
| Plan | "Classify + group" agent | Scenarios approved | Draft `dispatch-plan.md` |
| Execute | One per scenario, adaptive batching | Dispatch approved | One `findings/Fxxx-*.md` per scenario |
| Retest | "Diagnose + propose suggestions" agent | Per finding, on demand | 2–4 suggested next moves for `AskUserQuestion` |
| Report | "Synthesize report" agent | User declares bash complete | Final `report.md` |

### When NOT to spawn subagents

- Short conversational exchanges with the human (criteria questions, approvals)
- Reading a single small artifact already on disk
- Any step where the orchestrator needs raw content inline to keep dialogue coherent
- Trivial decisions that don't warrant spawn overhead

### Subagent prompt contract (enforced across all phases)

Every spawned agent gets:
1. **Self-contained context** — exact files/snippets inline; no "see conversation so far"
2. **Explicit output spec** — "write result to `.bb/{slug}/{artifact}` using `templates/{template}.md`"
3. **Scope fence** — "do not edit files outside `.bb/{slug}/`"
4. **Compact return format** — one-paragraph summary pointing at the artifact; no echoing full output

### Why this matters

Without this rule, orchestrator context fills with raw JIRA content, source dumps, long reasoning chains, and dozens of findings. By Phase 6 you hit a wall.

With this rule, orchestrator holds only: the current phase's artifact (one file at a time), `bash.json`, `STATUS.md`, the conversation. Everything else stays on disk, accessed via Read when actually needed. Also makes `/clear` + resume work — artifacts are the source of truth; conversation is disposable.

---

## 3. Phase walk-through of `/bb:run`

### Entry logic

```
if args provided:
  start new bash with slug derived from args + date
elif active bash in .bb/*/bash.json:
  if one: auto-resume via STATUS.md "exact next action"
  if many: AskUserQuestion to pick
else:
  start new bash
```

### Phase 1 — Ingest

- Read `connectors/integrations.md` (manifest only)
- `AskUserQuestion`: multi-select connectors
- Read only the selected detail files
- **Spawn one subagent per connector, in parallel.** Each gets its detail file + human-supplied source. Writes its section into `context.md`, returns compact summary.
- Show assembled `context.md` summary to human
- **Gate**: `AskUserQuestion` — "context complete / add more / restart"
- Pause reminder

### Phase 2 — Setup

- `AskUserQuestion`: "Setup strategy?" → infer-from-repo / walk-through-manually / both
- If infer: **spawn subagent** reading `.env.example`, compose files, README, package scripts; produces draft `setup.md`
- If manual: conversational capture (env, auth, base URL, shared preconditions)
- **Human wait gate**: `AskUserQuestion` — "Env actually ready? / not yet / revise". Blocks until confirmed.
- **Artifact**: `setup.md`
- Pause reminder

### Phase 3 — Define

- Conversational capture of acceptance criteria
- **Spawn subagent**: "Draft 8–12 scenarios from context.md + setup.md + criteria using `templates/scenario.md`." Returns structured list.
- Per proposed scenario, `AskUserQuestion`: keep / edit / drop / split
  - edit → conversational refine; split → creates two slots, fills both
- Allow adding net-new scenarios (human-proposed)
- **Gate**: `AskUserQuestion` — "scenario list locked?"
- **Artifact**: `scenarios.md`
- Pause reminder

### Phase 4 — Plan (adaptive dispatch)

- **Spawn subagent**: "Read `scenarios.md` + `agents/agents.md` manifest. Classify each scenario by agent type. Group into dispatch batches. Produce `dispatch-plan.md` draft using template."

Agent-type selection inside the subagent:

```
Scenario touches UI?            → browser
elif scenario hits HTTP endpoint? → api
elif scenario invokes shell/CLI?  → cli
else                               → generic
```

- Orchestrator presents plan: "3 browser agents in parallel on S01–S03; 1 API agent serial on S04–S07; 1 CLI agent on S08. Max concurrent: 4."
- **Gate**: `AskUserQuestion` — approve / modify / cancel
- **Artifact**: `dispatch-plan.md`
- Pause reminder — **loudest**, because Phase 5 is expensive

### Phase 5 — Execute

- Read `agents/agents.md` (manifest), Read only detail files for agent types in plan
- For each scheduled run: **spawn subagent** with full `setup.md` + assigned scenarios + agent type's prompt template
- Subagents write `findings/Fxxx-{slug}.md` using `templates/finding.md`. Return compact summary ("S02 → 2 findings open, severity high/medium").
- Orchestrator **never inlines finding content**. Tracks counts only.
- Announce: "12 scenarios run · 5 findings open · 7 passing. See `.bb/{slug}/findings/`."
- **Artifact**: `findings/Fxxx-*.md`
- Pause reminder — **heaviest pressure point**

### Phase 6 — Retest + Report

**Retest loop** (per open finding):
- **Spawn subagent**: "Read `findings/Fxxx` + originating scenario. Propose 2–4 retest strategies." Returns compact list.
- `AskUserQuestion`: **fix-and-retest** / **mark-known** / **refine-criteria** / **skip**
  - fix-and-retest → wait for human "fix is in" → re-dispatch that single scenario agent → update finding → append to `retest-log.md`
  - refine-criteria → backtrack to Define, archive downstream, re-execute affected scenario on return
  - mark-known / skip → log in `retest-log.md`, move on

**Report**:
- `AskUserQuestion`: "bash complete?"
- On yes: **spawn subagent** — "Read all findings + retest-log + scenarios. Produce `report.md` using `templates/report.md`."
- Orchestrator reads `report.md` summary, updates `bash.json` to `status: complete`
- **Artifact**: `retest-log.md`, `report.md`

---

## 4. Connector contract

Every connector follows a fixed structure. `/bb:run` reads the manifest to pick; `/bb:integration` uses the contract as a scaffolding template.

### 4.1 Manifest — `connectors/integrations.md`

Tiny file loaded at startup. Detail files are NOT loaded here.

```markdown
# Available Connectors

| ID    | Title        | Detail path                | When to use                             | Needs setup? |
|-------|--------------|----------------------------|-----------------------------------------|--------------|
| paste | Paste inline | connectors/paste/paste.md  | Ad-hoc — paste ticket/doc body in chat  | No           |
| url   | URL fetch    | connectors/url/url.md      | Public or auth'd-link URLs              | No           |
| code  | Local code   | connectors/code/code.md    | Source files, READMEs in the repo       | No           |
| jira  | JIRA         | connectors/jira/jira.md    | Formal JIRA tickets                     | Yes (MCP/API) |
| gdocs | Google Docs  | connectors/gdocs/gdocs.md  | Specs/PRDs in Drive                     | Yes (OAuth)   |
```

**When to use** drives human selection. **Needs setup?** drives pre-flight behavior.

### 4.2 Detail file shape — `connectors/<id>/<id>.md`

Fixed section order. Frontmatter + seven mandatory sections.

```markdown
---
id: jira
title: JIRA
version: 1.0.0
requires_mcp: false
auth_required: true
---

# JIRA Connector

## When to use
<1–3 bullet points — when a human picks this>

## Inputs the user must provide
<explicit list — URL, ticket ID, file path, raw text>

## Dependencies
<MCP servers, CLI tools, env vars, auth tokens>

## Pre-flight check
<how orchestrator verifies usability before dispatch>
<returns: ready | needs-setup | unreachable>

## Fetch recipe (subagent instructions)
<explicit step-by-step for dispatched subagent — including failure paths>

## Output section
<exact heading + markdown structure subagent appends to context.md>

## Setup steps
<instructions /bb:integration uses to help install this connector>
```

### 4.3 What a connector subagent receives

On dispatch, prompt contains:
1. Full detail file contents (the recipe)
2. User-provided source (URL, ticket ID, file path, pasted text)
3. Write target: `.bb/{slug}/context.md`
4. Scope fence: "only write to that file"
5. Return contract: "one-line summary of what you pulled"

Subagent runs the recipe, handles failures per its "Fetch recipe" failure paths, writes its section, returns.

### 4.4 Pre-flight check protocol

Before ANY subagent dispatch, the orchestrator runs the connector's pre-flight.

```
User picks connector X
  → Run X's pre-flight check
    → Ready?
        yes → Dispatch subagent
        no → Fixable via setup?
            yes → Offer: run /bb:integration, pick different, or retry
            unreachable → Surface error, pick different or cancel
```

Pre-flight failures are surfaced explicitly. Never silent.

### 4.5 Connector authoring via `/bb:integration`

Uses a meta-template `templates/connector.md`:

1. `AskUserQuestion`: install existing / browse catalog / **author custom**
2. If custom:
   - Conversational capture: ID (slug), title, one-line description
   - `AskUserQuestion`: transport type — MCP / CLI tool / WebFetch only / shell script
   - `AskUserQuestion`: input shape — URL / ID / file path / raw text / other
   - Scaffold `connectors/<id>/<id>.md` from meta-template with those values filled in
   - Append row to `integrations.md`
   - `AskUserQuestion`: "Test fetch with a sample input now?" → if yes, spawns the connector's subagent against sample input, shows result
3. If install existing: walks user through that connector's "Setup steps" section

### 4.6 Versioning

Each connector's `version:` frontmatter is captured in `bash.json` at Phase 1:

```json
"connectors_used": [
  { "id": "jira", "version": "1.0.0" },
  { "id": "code", "version": "1.2.0" }
]
```

Preserves backtrack integrity — if a connector is updated mid-bash, `bash.json` still records the version used.

### 4.7 Ownership contract

**Main orchestrator**: reads manifest, runs pre-flight, dispatches subagents, reads assembled `context.md`, writes `STATUS.md` + `bash.json`.

**Connector subagent**: reads only its recipe + user-supplied source. Writes only its section in `context.md`. Returns compact summary.

Never overlaps. Orchestrator never fetches directly; subagents never touch state files other than `context.md`.

## 5. Agent prompt contract

Mirrors the connector contract in shape. Same split: manifest + detail file + scope fence + return contract. Connectors fetch context; agents test scenarios.

### 5.1 Manifest — `agents/agents.md`

```markdown
# Available Agent Types

| ID      | Title          | Detail path               | Use when                                  | Dependencies         |
|---------|----------------|---------------------------|-------------------------------------------|----------------------|
| browser | Browser tester | agents/browser/browser.md | Scenario interacts with a web UI          | chrome-devtools MCP  |
| api     | API tester     | agents/api/api.md         | Scenario hits an HTTP endpoint directly   | curl / http tooling  |
| cli     | CLI tester     | agents/cli/cli.md         | Scenario invokes a CLI / shell command    | bash, target binary  |
| generic | Generic tester | agents/generic/generic.md | Fallback when scenario doesn't fit above  | depends on scenario  |
```

### 5.2 Detail file shape — `agents/<id>/<id>.md`

Frontmatter + six mandatory sections.

```markdown
---
id: browser
title: Browser tester
version: 1.0.0
requires_mcp: true
mcp_servers: [chrome-devtools]
---

# Browser Tester Agent

## When to use
<1–3 bullets — when Plan-phase classifier picks this agent>

## Tools required
<MCP servers, binaries, env — same shape as connector>

## Pre-flight check
<how orchestrator verifies this agent is dispatchable>
<returns: ready | needs-setup | unreachable>

## Test recipe (subagent instructions)
<explicit step-by-step the dispatched subagent follows>

## Evidence conventions
<where to save screenshots, how to capture logs, inline vs file>

## Failure handling
<tool unavailable / setup blocked / scenario ambiguous — what to return>
```

### 5.3 What an agent subagent receives

On dispatch, prompt contains:
1. Full detail file (the recipe)
2. Full `.bb/{slug}/setup.md` contents (env, auth, preconditions)
3. The specific scenario(s) assigned to this run — extracted from `scenarios.md`
4. Write target directory: `.bb/{slug}/findings/`
5. Scope fence: "only write inside findings/, using `templates/finding.md`"
6. Return contract: compact per-scenario summary (e.g., "S01: PASS. S02: 1 finding (high). S03: 2 findings.")

Subagent executes setup → per-scenario preconditions → test steps → compare actual vs expected → write finding on discrepancy.

### 5.4 Dispatch plan structure — what goes in `dispatch-plan.md`

The Plan-phase subagent produces entries like:

```markdown
## Dispatch Plan

### Wave 1 — parallel, max concurrent 3
- Agent type: browser
- Scenarios: S01, S02, S03
- Mode: one subagent per scenario (full isolation)

### Wave 2 — serial
- Agent type: api
- Scenarios: S04, S05, S06, S07
- Mode: single subagent runs all four sequentially

### Wave 3 — single
- Agent type: cli
- Scenarios: S08
- Mode: single subagent
```

**Mode** drives dispatch multiplicity:
- `one-per-scenario` — N subagents for N scenarios, max isolation
- `batched-serial` — 1 subagent, scenarios run in sequence (cheaper, fine for stateless API calls)

Orchestrator decides Mode per wave based on scenario characteristics (browser = usually isolated; API = often batchable).

### 5.5 Finding template — `templates/finding.md`

Every finding file follows this shape.

```markdown
---
id: F001
scenario: S02
agent_type: browser
severity: high | medium | low
status: open | resolved | known
created_at: 2026-04-15T14:32:00Z
retest_cycles: 0
---

# F001 — <title>

## Summary
<one paragraph>

## Scenario
<reference to S02, with link to scenarios.md>

## Repro steps
1. …
2. …

## Expected
<from scenarios.md>

## Actual
<what happened>

## Evidence
<screenshots, console logs, network errors, stack traces>

## Notes
<agent observations — timing, edge cases>
```

### 5.6 Evidence handling

Per-finding evidence lives in `findings/Fxxx-<slug>/evidence/` (peer to the finding file when evidence is binary). Small logs/errors stay inline in the finding markdown. Binary artifacts (screenshots, HAR files) get their own subdirectory.

```
findings/
├── F001-login-blank.md
├── F001-login-blank/
│   └── evidence/
│       ├── screenshot-before.png
│       └── network-har.json
└── F002-403-on-refresh.md    # no evidence dir — pure text finding
```

### 5.7 Versioning

Same pattern as connectors. `bash.json` records which agent versions ran:

```json
"dispatch_summary": {
  "agents_used": [
    { "id": "browser", "version": "1.0.0", "runs": 3 },
    { "id": "api", "version": "1.0.0", "runs": 1 }
  ]
}
```

### 5.8 Agent-type authoring is NOT part of `/bb:integration` in v1

Scope decision: `/bb:integration` handles connectors only (ingest side). Agent-type authoring is a future concern. For v1, users add new agent types by hand following this contract — same shape as connectors, so experienced users can do it unaided.

Open item to decide later: whether a `/bb:agent` command (or an extension to `/bb:integration`) gets added in a future iteration.

### 5.9 Ownership contract

**Main orchestrator**: reads manifest, runs pre-flight per agent type used in plan, dispatches subagents per Dispatch Plan, tracks returns (counts only), updates `STATUS.md` + `bash.json`.

**Agent subagent**: reads only its recipe + setup.md + assigned scenarios. Writes only findings under `findings/`. Returns compact per-scenario summary. Never touches other state files.

## 6. Iron laws / hard gates

Non-negotiable rules encoded in `commands/run.md` and `commands/integration.md`. Violations block the workflow.

### Iron Laws

1. **No phase advances without explicit human approval.** Every phase ends with an `AskUserQuestion` gate. The orchestrator never auto-advances.

2. **Orchestrator never ingests raw content.** Connector subagents read sources; agent subagents execute tests. The orchestrator only reads `.bb/<slug>/` artifacts. Eliminates the "token bloat by Phase 6" failure mode.

3. **STATUS.md is write-through.** Updated BEFORE and AFTER every significant action — subagent spawn, subagent return, AskUserQuestion response, phase transition. Worst-case data loss = one atomic step.

4. **Subagents have strict scope fences.** Every subagent prompt declares exactly which files it may write. Connector agents → `context.md` only. Test agents → `findings/` only. Planning agents → their one target artifact.

5. **Backtracking archives, never deletes.** Any backtrack moves affected downstream artifacts to `.history/<timestamp>/`. Rolling back is reversible.

6. **Pre-flight before dispatch.** Every connector and agent type declares a pre-flight check. Orchestrator runs it and surfaces failures explicitly — never silent fallback.

7. **Findings are always rich.** No binary PASS/FAIL. Every discrepancy produces a titled, severity-classified, evidence-bearing finding using `templates/finding.md`.

8. **Human always owns retest disposition.** Skill proposes 2–4 options per finding; human picks. Skill never auto-retests without the explicit "fix is in" signal.

9. **Setup phase blocks on human confirmation.** `setup.md` is not considered ready until the human explicitly confirms the environment is standing up. No agent dispatch happens on unconfirmed setup.

10. **One active bash per `.bb/<slug>/`.** Concurrent writes into the same slug are not supported. Multiple bashes = multiple slugs.

### Hard gates (where a violation aborts the workflow)

| Gate | Where | What aborts |
|------|-------|-------------|
| Missing artifact | Any phase transition | If the prior phase's artifact doesn't exist on disk, abort — don't fake it |
| Pre-flight failure without human dismiss | Phase 1 and Phase 5 | If connector/agent pre-flight fails AND user didn't explicitly pick "retry anyway," abort that dispatch |
| Corrupt `bash.json` | Resume | If `bash.json` is unreadable, refuse to auto-resume; surface repair options |
| `STATUS.md` out of sync with `bash.json` | Resume | If phase markers disagree, surface to human; don't guess |

### Red-flag thoughts

Same pattern as `systematic-debugging`. If the orchestrator (or the model running the skill) catches itself thinking any of these, STOP and return to process:

| Thought | Reality |
|---------|---------|
| "The human obviously wants to advance, skip the gate" | All gates are explicit for a reason — surprise advances destroy trust |
| "Just read the raw JIRA content directly, faster than spawning" | The subagent rule exists because shortcuts here blow Phase 6 context |
| "STATUS.md is basically accurate, don't bother rewriting" | Write-through is the only protection against session death |
| "This finding is obviously not a bug, skip the template" | Rich finding format is the contract — always use it |
| "Let me auto-retest since the human probably meant yes" | Retest is human-gated. Full stop. |

### Phase-boundary checklist

At every phase boundary, orchestrator verifies:
- [ ] Artifact file exists at expected path
- [ ] Artifact is valid (non-empty, follows template where applicable)
- [ ] `bash.json` updated with new `current_phase`
- [ ] `STATUS.md` rewritten with next-phase "exact next action"
- [ ] `INDEX.md` regenerated
- [ ] Pause reminder emitted

Missing any of these = orchestrator refuses to advance.

## 7. Report format

The final deliverable. Produced by the report subagent spawned at Phase 6 completion. Audience: anyone who didn't run the bash (devs, PM, QA leads, stakeholders).

### 7.1 Template — `templates/report.md`

Has two views of findings: a severity index up top for quick scanning, plus full detail inline below so the report is self-contained.

```markdown
---
bash_slug: <slug>
bash_title: <title>
completed_at: <ISO timestamp>
duration: <human-readable>
connectors: [<ids>]
agent_types: [<ids>]
---

# Bug Bash Report — <title>

## Executive summary
<1–3 sentences: what was tested, how many scenarios, headline finding counts, overall verdict>

## Scope
- **Context sources**: <connectors used, with source refs>
- **Scenarios run**: <count> (<pass>/<fail>/<blocked>)
- **Setup**: <base URL, auth mode, key preconditions — copied from setup.md>
- **Agent types used**: <list with run counts>

## Findings — index by severity

### High (<N>)
- **F001** — <title> · S02 · open — [detail](#f001)
- **F004** — <title> · S05 · resolved after 2 retests — [detail](#f004)

### Medium (<N>) / Low (<N>)
<same pattern>

## Findings — detail

### F001 — <title>
- **Severity**: high · **Status**: open · **Scenario**: S02 · **Agent**: browser · **Retest cycles**: 0

**Repro steps**:
1. Navigate to `/login`
2. Enter admin@example.com + correct password
3. Click "Sign in"

**Expected**: redirect to `/dashboard`; user greeting visible
**Actual**: blank page, console error `Cannot read property 'token' of undefined`

**Evidence**:
- [Screenshot — blank page](findings/F001-login-blank/evidence/screenshot-after.png)
- [Console log](findings/F001-login-blank/evidence/console.log)
- [Network HAR](findings/F001-login-blank/evidence/network.har)

**Notes**: reproducible 3/3 in Chrome 120; Firefox not tested.

**Retest history**:
- 2026-04-15 16:12 — Fix attempt after PR #4521 deploy. Result: still failing, same console error. Evidence: `findings/F001-login-blank/evidence/retest-1/`

## Known issues / skipped
- **F007** — marked known (existing bug, tracked in <ref>)
- **S09** — skipped (blocked on staging env)

## Retest summary
- Total retest cycles: <N>
- Scenarios re-run: <list>
- Criteria refinements: <list of scenarios whose spec was updated mid-bash>

## Recommended next steps
<1–5 bullets: what the dev team should tackle first, priority order>

## Artifacts
- Context: `.bb/<slug>/context.md`
- Setup: `.bb/<slug>/setup.md`
- Scenarios: `.bb/<slug>/scenarios.md`
- Dispatch plan: `.bb/<slug>/dispatch-plan.md`
- Findings: `.bb/<slug>/findings/`
- Retest log: `.bb/<slug>/retest-log.md`
```

### 7.2 Attachments / evidence lifecycle

**Where evidence lives**: each finding gets a peer directory `findings/Fxxx-<slug>/evidence/`. Binary artifacts (screenshots, HAR files, PDFs, video clips, DB dumps) go here. Small text artifacts (stack traces, console logs) can live inline in the finding markdown OR as files in `evidence/` — at agent's discretion.

**Retest evidence isolation**: retest artifacts go in `evidence/retest-N/` (numbered per cycle). Initial run lives in `evidence/` root.

**Human-added attachments**: during Phase 6 retest, `/bb:run` exposes an "attach to finding" affordance — human types "attach screenshot to F001," skill prompts for local path + description, copies file into `findings/Fxxx-<slug>/evidence/` (or the active `retest-N/`), appends entry to the finding's `Evidence:` section.

For v1, this is a conversational affordance inside `/bb:run`, not a separate command.

### 7.3 Bundle option when sharing

Report references evidence by **relative path from `.bb/<slug>/`**. Sharing requires either pushing the whole `.bb/<slug>/` tree (git, zip) or generating a bundle.

- **v1 default**: relative paths. Users share by copying `.bb/<slug>/` wholesale.
- **v1.1 future**: `AskUserQuestion` after report write: "Bundle for sharing?" → produces `.bb/<slug>/bundle.zip` with report + referenced evidence flattened. *(Not building in v1; noted as design hook.)*

### 7.4 What the report subagent receives

1. `templates/report.md`
2. Full `scenarios.md`, `retest-log.md`, `bash.json`
3. **Full contents of all `findings/*.md`** (report is the one place inline detail is warranted — it's the terminal step)
4. Evidence directory listing for each finding (paths, so subagent can link without reading binaries)
5. Write target: `.bb/<slug>/report.md`
6. Return contract: compact summary ("Report written. 12 scenarios, 5 findings (2 high / 2 medium / 1 low), 3 resolved via retest, 1 known, 0 blocked.")

### 7.5 What the orchestrator does after

1. Reads `report.md` (the single heavy read the orchestrator does — at the end, when context pressure is acceptable)
2. Updates `bash.json` → `status: complete`
3. Rewrites `STATUS.md` with final state snapshot
4. Regenerates `INDEX.md` (bash moves from active to completed)
5. `AskUserQuestion`: **archive now** / **leave active** / **start new bash**
6. On archive → move `.bb/<slug>/` to `.bb/archive/<slug>/`

### 7.6 Report principles

- **Executive-summary-first.** Verdict in the first 3 sentences.
- **Severity groups, not scenario order.** Findings matter; scenario numbers are bookkeeping.
- **Full findings detail inline.** Report is self-contained for reading.
- **Evidence via relative links, not inlined binaries.** Report stays readable.
- **Retest history visible per finding.** Helps re-readers see trajectory.

### 7.7 No mid-bash reports

Deliberately excluded in v1: no "interim report" mid-bash. The orchestrator's running state IS the report until Phase 6 completes. Mid-bash snapshot = read `STATUS.md` + `findings/` directly.

---

## Open questions / still to decide

- Exact `plugin.json` shape (Claude Code plugin manifest details)
- Whether `/bb:integration` also supports uninstalling / disabling a connector, or just adding
- Whether INDEX.md rebuild is on every write or on-demand
- Whether `.bb/<slug>/` should include a `NOTES.md` for human free-form notes during the bash
- How `STATUS.md` integrates with `bash.json` updates (single atomic write or two sequential writes — and what if the second fails)
