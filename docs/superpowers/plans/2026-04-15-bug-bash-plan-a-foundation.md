# Bug Bash — Plan A: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a minimum viable `bb` Claude Code plugin that drives a full 6-phase bug bash end-to-end with two connectors (`paste`, `code`) and two agent types (`generic`, `api`), plus all cross-cutting infrastructure — templates, references, state management (bash.json + STATUS.md + INDEX.md + backtrack archive), resume logic, and the `/bb:run` orchestrator.

**Architecture:** Claude Code plugin. Orchestrator is markdown (`commands/run.md`) that drives the conversation and delegates heavy work to subagents and a tiny Node CLI (`scripts/bb`) that owns deterministic utilities: slug derivation, bash.json CRUD, STATUS.md/INDEX.md rendering, history archive, active-bash discovery, JSON schema validation. All persistent state lives in the user's project under `.bb/<slug>/`.

**Tech Stack:** Node 20+ (CLI + built-in `node --test`), `ajv` + `ajv-formats` for JSON schema validation. No other runtime deps. Plugin files are pure markdown. Tests are a mix of mechanical (`node --test`) for anything deterministic and documented manual acceptance walkthroughs for the orchestrator conversation flow.

---

## Scope

**Plan A ships:**
- Plugin manifest (`.claude-plugin/plugin.json`) + top-level `README.md` so the plugin installs via `/plugin`
- Node CLI (`scripts/bb.mjs`) with the full utility surface
- All 7 templates (`context`, `setup`, `scenario`, `dispatch-plan`, `finding`, `pause-reminder`, `report`)
- All 5 reference docs (`workflow-phases`, `setup-playbook`, `dispatch-playbook`, `retest-playbook`, `writing-connectors`)
- Connector contract (`connectors/README.md`) + manifest + `paste` and `code` connectors (no external deps)
- Agent contract (`agents/README.md`) + manifest + `generic` and `api` agents (no MCP deps)
- Full `/bb:run` orchestrator covering all 6 phases, resume, and backtrack

**Plan A defers to Plan B:** `url`/`jira`/`gdocs` connectors, `/bb:integration` command, `templates/connector.md` meta-template.

**Plan A defers to Plan C:** `browser`/`cli` agent types, evidence-directory conventions exercised in practice, report/retest polish, bundle-for-sharing.

**End state:** Fred can run `/plugin install <local path>`, invoke `/bb:run "test feature"`, paste in a ticket body, pick `generic` agent, get rich findings back, retest, and receive a report. All state persisted, survives `/clear`, backtrack-safe.

---

## File structure

**Create (repo root `/Users/fredsun/Code/bb/`):**
- `.claude-plugin/plugin.json` — plugin manifest (superpowers shape)
- `README.md` — install + usage docs (overwrites the 5-byte stub)
- `package.json` — test deps + `npm test` script
- `.gitignore` — node_modules, test artifacts
- `scripts/bb.mjs` — Node CLI entry point; single file with all subcommands
- `scripts/lib/schemas.mjs` — JSON schema definitions
- `commands/run.md` — `/bb:run` orchestrator
- `templates/{context,setup,scenario,dispatch-plan,finding,pause-reminder,report}.md` — 7 files
- `references/{workflow-phases,setup-playbook,dispatch-playbook,retest-playbook,writing-connectors}.md` — 5 files
- `connectors/README.md`, `connectors/integrations.md`, `connectors/paste/paste.md`, `connectors/code/code.md`
- `agents/README.md`, `agents/agents.md`, `agents/generic/generic.md`, `agents/api/api.md`
- `tests/*.test.mjs` — one mechanical test file per utility (see per-task)
- `tests/acceptance/*.md` — manual walkthroughs

**Modify:** none (repo is green-field aside from the stub README).

---

## Cross-cutting contracts

These get locked down in early tasks and referenced by later tasks. If any later task is tempted to drift from these, stop and surface.

### Slug format

`<title-kebab>-<YYYY-MM-DD>`. Title kebab: lowercase, non-alphanumeric runs → single `-`, trimmed. On collision (same slug exists in `.bb/`), append `-2`, `-3`, etc. Examples:
- `"Auth feature"` + `2026-04-15` → `auth-feature-2026-04-15`
- `"Billing!! v2"` + `2026-04-15` → `billing-v2-2026-04-15`
- Collision second time same day → `auth-feature-2026-04-15-2`

### bash.json schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["slug", "title", "created_at", "current_phase", "status"],
  "additionalProperties": false,
  "properties": {
    "slug":          { "type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$" },
    "title":         { "type": "string", "minLength": 1 },
    "created_at":    { "type": "string", "format": "date-time" },
    "current_phase": { "enum": ["ingest", "setup", "define", "plan", "execute", "retest", "complete"] },
    "status":        { "enum": ["active", "paused", "complete", "abandoned"] },
    "connectors_used": {
      "type": "array",
      "items": { "type": "object", "required": ["id", "version"],
                 "properties": { "id": {"type":"string"}, "version": {"type":"string"} },
                 "additionalProperties": false }
    },
    "dispatch_summary": {
      "type": "object",
      "properties": {
        "agents_used": {
          "type": "array",
          "items": { "type": "object", "required": ["id", "version", "runs"],
                     "properties": { "id": {"type":"string"}, "version": {"type":"string"}, "runs": {"type":"integer", "minimum": 0} },
                     "additionalProperties": false }
        }
      },
      "additionalProperties": false
    },
    "finding_counts": {
      "type": "object",
      "required": ["open", "resolved", "known"],
      "properties": {
        "open":     { "type": "integer", "minimum": 0 },
        "resolved": { "type": "integer", "minimum": 0 },
        "known":    { "type": "integer", "minimum": 0 }
      },
      "additionalProperties": false
    },
    "retest_cycles": { "type": "integer", "minimum": 0 }
  }
}
```

### STATUS.md shape (fixed sections, in order)

```markdown
# Status — <title>

**Phase:** <phase>
**Status:** <one-liner>

## Where we left off
<narrative>

## Exact next action on resume
<literal instruction for the resuming orchestrator>

## Phase progress
- [x] Ingest
- [ ] Setup
- [ ] Define
- [ ] Plan
- [ ] Execute
- [ ] Retest + Report

## Pending decisions / subagent runs
<or "None">

## Recent events
- <ISO ts> — <event>
```

### CLI subcommand surface (`scripts/bb.mjs`)

All commands exit non-zero on error, print a one-line diagnostic to stderr. Stdout is machine-readable where noted.

| Subcommand | Purpose | Stdout |
|---|---|---|
| `bb slug <title> [--date YYYY-MM-DD] [--root <dir>]` | Derive a unique slug (checks `<root>/.bb/` for collisions) | slug |
| `bb init <slug> <title> [--root <dir>]` | Create `.bb/<slug>/` + `bash.json` (phase=`ingest`, status=`active`) + empty `STATUS.md` stub | slug |
| `bb json get <slug> [--root <dir>]` | Print bash.json | JSON |
| `bb json set <slug> <jq-like path> <value> [--root <dir>]` | Update a field (only whitelisted paths; see Task 6) | updated JSON |
| `bb phase <slug> <phase> [--root <dir>]` | Set `current_phase` (validates against enum) | updated JSON |
| `bb status-md <slug> --phase <p> --status <s> --next <text> [--narrative <text>] [--pending <text>] [--event <text>] [--root <dir>]` | Write `STATUS.md` from current bash.json + args | STATUS.md path |
| `bb index [--root <dir>]` | Regenerate `.bb/INDEX.md` from all `bash.json` files | INDEX.md path |
| `bb archive <slug> <file...> [--root <dir>]` | Move files into `.bb/<slug>/.history/<iso-ts>/` (preserves relative paths) | history dir |
| `bb active [--root <dir>]` | List slugs where `status=active`, one per line | slug list |
| `bb validate <file> [--root <dir>]` | Validate any bash.json against schema | "ok" or error |

`--root` defaults to `process.cwd()`. All subcommands respect it so tests can use tmpdirs.

### Testing model

**Mechanical (`node --test` in `tests/*.test.mjs`):** every CLI subcommand, schema validator, slug derivation, STATUS.md/INDEX.md rendering, archive operation.

**Manual walkthrough (`tests/acceptance/*.md`):** per-phase orchestrator acceptance checklist + end-to-end smoke.

Each phase task ends with running the corresponding acceptance walkthrough interactively with Fred before the task's commit.

### Git conventions

Commit messages: conventional (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). No co-author trailer unless Fred asks. Commit after every task step that leaves the tree in a good state.

---

## Tasks

### Task 1: Repo scaffolding — package.json, .gitignore, tests dir

**Files:**
- Create: `/Users/fredsun/Code/bb/package.json`
- Create: `/Users/fredsun/Code/bb/.gitignore`
- Create: `/Users/fredsun/Code/bb/tests/smoke.test.mjs`

- [ ] **Step 1: Write the smoke test**

`tests/smoke.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('test harness runs', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 2: Run and confirm it fails (no package.json yet)**

Run: `cd /Users/fredsun/Code/bb && node --test tests/`
Expected: FAIL — node may load tests, but `npm test` won't work yet. The point is the harness isn't wired up. Alternate: `npm test` → "npm ERR! Missing script: test".

- [ ] **Step 3: Write package.json**

`package.json`:
```json
{
  "name": "bb",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test tests/"
  },
  "devDependencies": {
    "ajv": "^8.12.0",
    "ajv-formats": "^2.1.1"
  }
}
```

- [ ] **Step 4: Write .gitignore**

`.gitignore`:
```
node_modules/
.bb/
*.log
.DS_Store
```

- [ ] **Step 5: Install deps and run the smoke test**

Run: `cd /Users/fredsun/Code/bb && npm install && npm test`
Expected: PASS. One test, one assertion.

- [ ] **Step 6: Commit**

```bash
cd /Users/fredsun/Code/bb
git add package.json package-lock.json .gitignore tests/smoke.test.mjs
git commit -m "chore: initialize Node test harness"
```

---

### Task 2: Plugin manifest

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `tests/plugin-manifest.test.mjs`

- [ ] **Step 1: Write the failing test**

`tests/plugin-manifest.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('plugin manifest is valid', async () => {
  const raw = await readFile(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(raw);
  assert.equal(manifest.name, 'bb');
  assert.ok(manifest.description && manifest.description.length > 0);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.author && manifest.author.name);
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test`
Expected: FAIL — `ENOENT: no such file or directory, open '.../plugin.json'`.

- [ ] **Step 3: Create manifest**

`.claude-plugin/plugin.json`:
```json
{
  "name": "bb",
  "description": "Structured bug-bash workflow: connector-based context ingest, agent-driven scenario testing, rich findings, human-gated retest, final report.",
  "version": "0.1.0",
  "author": {
    "name": "Fred Sun",
    "email": "fredthekid@gmail.com"
  },
  "license": "MIT",
  "keywords": ["bug-bash", "testing", "qa", "workflow"]
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npm test`
Expected: PASS for `plugin manifest is valid`.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/plugin.json tests/plugin-manifest.test.mjs
git commit -m "feat: add plugin manifest"
```

---

### Task 3: Slug derivation CLI subcommand

**Files:**
- Create: `scripts/bb.mjs` (entry point, dispatcher only)
- Create: `scripts/lib/slug.mjs`
- Create: `tests/slug.test.mjs`

- [ ] **Step 1: Write failing tests**

`tests/slug.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveSlug } from '../scripts/lib/slug.mjs';

test('slug: basic kebab', () => {
  assert.equal(deriveSlug('Auth feature', { date: '2026-04-15', root: tmpdir() }),
               'auth-feature-2026-04-15');
});

test('slug: punctuation collapses to single dash', () => {
  assert.equal(deriveSlug('Billing!! v2', { date: '2026-04-15', root: tmpdir() }),
               'billing-v2-2026-04-15');
});

test('slug: leading/trailing junk trimmed', () => {
  assert.equal(deriveSlug('  ---Auth---  ', { date: '2026-04-15', root: tmpdir() }),
               'auth-2026-04-15');
});

test('slug: collision appends numeric suffix', () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-slug-'));
  mkdirSync(join(root, '.bb', 'auth-feature-2026-04-15'), { recursive: true });
  assert.equal(deriveSlug('Auth feature', { date: '2026-04-15', root }),
               'auth-feature-2026-04-15-2');
  mkdirSync(join(root, '.bb', 'auth-feature-2026-04-15-2'));
  assert.equal(deriveSlug('Auth feature', { date: '2026-04-15', root }),
               'auth-feature-2026-04-15-3');
});

test('slug: empty title throws', () => {
  assert.throws(() => deriveSlug('   ', { date: '2026-04-15', root: tmpdir() }),
                /empty title/);
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../scripts/lib/slug.mjs'`.

- [ ] **Step 3: Implement slug derivation**

`scripts/lib/slug.mjs`:
```js
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function deriveSlug(title, { date, root }) {
  const kebab = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!kebab) throw new Error(`cannot derive slug from empty title: "${title}"`);

  const base = `${kebab}-${date}`;
  let candidate = base;
  let n = 2;
  while (existsSync(join(root, '.bb', candidate))) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}
```

- [ ] **Step 4: Implement CLI dispatcher**

`scripts/bb.mjs`:
```js
#!/usr/bin/env node
import { deriveSlug } from './lib/slug.mjs';

const [sub, ...rest] = process.argv.slice(2);

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i];
    else positional.push(args[i]);
  }
  return { flags, positional };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

const handlers = {
  slug(args) {
    const { flags, positional } = parseFlags(args);
    const [title] = positional;
    if (!title) { console.error('usage: bb slug <title> [--date YYYY-MM-DD] [--root <dir>]'); process.exit(2); }
    const root = flags.root ?? process.cwd();
    const date = flags.date ?? today();
    process.stdout.write(deriveSlug(title, { date, root }) + '\n');
  },
};

const handler = handlers[sub];
if (!handler) {
  console.error(`unknown subcommand: ${sub ?? '(none)'}`);
  console.error('available: ' + Object.keys(handlers).join(', '));
  process.exit(2);
}
handler(rest);
```

Make executable:
```bash
chmod +x /Users/fredsun/Code/bb/scripts/bb.mjs
```

- [ ] **Step 5: Run to confirm pass**

Run: `npm test`
Expected: PASS for all 5 slug tests.

Also smoke-check CLI: `node scripts/bb.mjs slug "Auth feature" --date 2026-04-15`
Expected stdout: `auth-feature-2026-04-15`.

- [ ] **Step 6: Commit**

```bash
git add scripts/bb.mjs scripts/lib/slug.mjs tests/slug.test.mjs
git commit -m "feat: slug derivation with collision suffix"
```

---

### Task 4: bash.json JSON schema + validator

**Files:**
- Create: `scripts/lib/schemas.mjs`
- Create: `scripts/lib/validate.mjs`
- Create: `tests/schema.test.mjs`
- Modify: `scripts/bb.mjs` (add `validate` subcommand)

- [ ] **Step 1: Write failing tests**

`tests/schema.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBashJson } from '../scripts/lib/validate.mjs';

const minimalValid = {
  slug: 'auth-feature-2026-04-15',
  title: 'Auth feature',
  created_at: '2026-04-15T12:00:00.000Z',
  current_phase: 'ingest',
  status: 'active',
};

test('schema: minimal valid bash.json passes', () => {
  const { valid, errors } = validateBashJson(minimalValid);
  assert.equal(valid, true, JSON.stringify(errors));
});

test('schema: missing slug fails', () => {
  const { valid } = validateBashJson({ ...minimalValid, slug: undefined });
  assert.equal(valid, false);
});

test('schema: bad phase enum fails', () => {
  const { valid } = validateBashJson({ ...minimalValid, current_phase: 'bogus' });
  assert.equal(valid, false);
});

test('schema: bad slug pattern fails', () => {
  const { valid } = validateBashJson({ ...minimalValid, slug: 'Auth Feature' });
  assert.equal(valid, false);
});

test('schema: additional top-level property fails', () => {
  const { valid } = validateBashJson({ ...minimalValid, extra: 'nope' });
  assert.equal(valid, false);
});

test('schema: finding_counts requires all three keys', () => {
  const { valid } = validateBashJson({ ...minimalValid, finding_counts: { open: 1 } });
  assert.equal(valid, false);
});

test('schema: full object with all fields passes', () => {
  const full = {
    ...minimalValid,
    connectors_used: [{ id: 'paste', version: '1.0.0' }],
    dispatch_summary: { agents_used: [{ id: 'generic', version: '1.0.0', runs: 3 }] },
    finding_counts: { open: 2, resolved: 1, known: 0 },
    retest_cycles: 1,
  };
  const { valid, errors } = validateBashJson(full);
  assert.equal(valid, true, JSON.stringify(errors));
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test`
Expected: FAIL — missing module.

- [ ] **Step 3: Implement schema + validator**

`scripts/lib/schemas.mjs`:
```js
export const bashJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['slug', 'title', 'created_at', 'current_phase', 'status'],
  additionalProperties: false,
  properties: {
    slug:          { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
    title:         { type: 'string', minLength: 1 },
    created_at:    { type: 'string', format: 'date-time' },
    current_phase: { enum: ['ingest', 'setup', 'define', 'plan', 'execute', 'retest', 'complete'] },
    status:        { enum: ['active', 'paused', 'complete', 'abandoned'] },
    connectors_used: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'version'],
        additionalProperties: false,
        properties: { id: { type: 'string' }, version: { type: 'string' } },
      },
    },
    dispatch_summary: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agents_used: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'version', 'runs'],
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              version: { type: 'string' },
              runs: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    },
    finding_counts: {
      type: 'object',
      required: ['open', 'resolved', 'known'],
      additionalProperties: false,
      properties: {
        open:     { type: 'integer', minimum: 0 },
        resolved: { type: 'integer', minimum: 0 },
        known:    { type: 'integer', minimum: 0 },
      },
    },
    retest_cycles: { type: 'integer', minimum: 0 },
  },
};
```

`scripts/lib/validate.mjs`:
```js
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { bashJsonSchema } from './schemas.mjs';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(bashJsonSchema);

export function validateBashJson(obj) {
  const valid = validate(obj);
  return { valid, errors: valid ? [] : validate.errors };
}
```

- [ ] **Step 4: Add `validate` subcommand to bb.mjs**

In `scripts/bb.mjs`, add to imports and handlers:
```js
import { readFile } from 'node:fs/promises';
import { validateBashJson } from './lib/validate.mjs';

// inside handlers:
async validate(args) {
  const { positional } = parseFlags(args);
  const [file] = positional;
  if (!file) { console.error('usage: bb validate <bash.json>'); process.exit(2); }
  const obj = JSON.parse(await readFile(file, 'utf8'));
  const { valid, errors } = validateBashJson(obj);
  if (valid) { process.stdout.write('ok\n'); return; }
  console.error('invalid:', JSON.stringify(errors, null, 2));
  process.exit(1);
},
```

Update handler dispatch to support async: change `handler(rest)` to `await handler(rest)` and wrap in `async function main()`.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all 7 schema tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/schemas.mjs scripts/lib/validate.mjs scripts/bb.mjs tests/schema.test.mjs
git commit -m "feat: bash.json schema and validator"
```

---

### Task 5: bash.json CRUD — init, get, set, phase

**Files:**
- Create: `scripts/lib/bashjson.mjs`
- Create: `tests/bashjson.test.mjs`
- Modify: `scripts/bb.mjs` (add `init`, `json get`, `json set`, `phase` subcommands)

- [ ] **Step 1: Write failing tests**

`tests/bashjson.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initBash, readBash, updateBash, setPhase } from '../scripts/lib/bashjson.mjs';

function mkroot() { return mkdtempSync(join(tmpdir(), 'bb-json-')); }

test('init: creates .bb/<slug>/bash.json with defaults', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'Test' });
  const raw = readFileSync(join(root, '.bb', 's1', 'bash.json'), 'utf8');
  const obj = JSON.parse(raw);
  assert.equal(obj.slug, 's1');
  assert.equal(obj.title, 'Test');
  assert.equal(obj.current_phase, 'ingest');
  assert.equal(obj.status, 'active');
  assert.ok(obj.created_at);
});

test('init: refuses to overwrite existing bash', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'Test' });
  assert.throws(() => initBash({ root, slug: 's1', title: 'Test' }), /already exists/);
});

test('read: round-trips', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'Test' });
  const obj = readBash({ root, slug: 's1' });
  assert.equal(obj.slug, 's1');
});

test('update: whitelist enforced', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'Test' });
  updateBash({ root, slug: 's1', path: 'status', value: 'paused' });
  assert.equal(readBash({ root, slug: 's1' }).status, 'paused');
  assert.throws(() => updateBash({ root, slug: 's1', path: 'slug', value: 'new' }), /not updatable/);
});

test('update: validates result against schema', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'Test' });
  assert.throws(() => updateBash({ root, slug: 's1', path: 'status', value: 'bogus' }), /invalid/);
});

test('setPhase: advances phase and validates', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'Test' });
  setPhase({ root, slug: 's1', phase: 'setup' });
  assert.equal(readBash({ root, slug: 's1' }).current_phase, 'setup');
  assert.throws(() => setPhase({ root, slug: 's1', phase: 'bogus' }), /invalid/);
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test`
Expected: FAIL — missing module.

- [ ] **Step 3: Implement bashjson.mjs**

`scripts/lib/bashjson.mjs`:
```js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateBashJson } from './validate.mjs';

// whitelist of updatable paths (dot-path syntax; only top-level for v1)
const UPDATABLE = new Set([
  'status',
  'connectors_used',
  'dispatch_summary',
  'finding_counts',
  'retest_cycles',
]);

function bashDir(root, slug) { return join(root, '.bb', slug); }
function bashFile(root, slug) { return join(bashDir(root, slug), 'bash.json'); }

export function readBash({ root, slug }) {
  return JSON.parse(readFileSync(bashFile(root, slug), 'utf8'));
}

function writeValidated(root, slug, obj) {
  const { valid, errors } = validateBashJson(obj);
  if (!valid) throw new Error(`invalid bash.json: ${JSON.stringify(errors)}`);
  mkdirSync(bashDir(root, slug), { recursive: true });
  writeFileSync(bashFile(root, slug), JSON.stringify(obj, null, 2) + '\n');
}

export function initBash({ root, slug, title }) {
  if (existsSync(bashFile(root, slug))) throw new Error(`bash already exists: ${slug}`);
  const obj = {
    slug, title,
    created_at: new Date().toISOString(),
    current_phase: 'ingest',
    status: 'active',
  };
  writeValidated(root, slug, obj);
  return obj;
}

export function updateBash({ root, slug, path, value }) {
  if (!UPDATABLE.has(path)) throw new Error(`field not updatable: ${path}`);
  const obj = readBash({ root, slug });
  obj[path] = value;
  writeValidated(root, slug, obj);
  return obj;
}

export function setPhase({ root, slug, phase }) {
  const obj = readBash({ root, slug });
  obj.current_phase = phase;
  writeValidated(root, slug, obj);
  return obj;
}
```

- [ ] **Step 4: Wire subcommands into bb.mjs**

Add to `handlers` in `scripts/bb.mjs`:
```js
import { initBash, readBash, updateBash, setPhase } from './lib/bashjson.mjs';

// ...
init(args) {
  const { flags, positional } = parseFlags(args);
  const [slug, title] = positional;
  if (!slug || !title) { console.error('usage: bb init <slug> <title> [--root <dir>]'); process.exit(2); }
  const root = flags.root ?? process.cwd();
  initBash({ root, slug, title });
  process.stdout.write(slug + '\n');
},
json(args) {
  const [op, ...rest] = args;
  const { flags, positional } = parseFlags(rest);
  const root = flags.root ?? process.cwd();
  if (op === 'get') {
    const [slug] = positional;
    process.stdout.write(JSON.stringify(readBash({ root, slug }), null, 2) + '\n');
  } else if (op === 'set') {
    const [slug, path, rawValue] = positional;
    const value = tryParseJson(rawValue);
    process.stdout.write(JSON.stringify(updateBash({ root, slug, path, value }), null, 2) + '\n');
  } else {
    console.error('usage: bb json <get|set> ...'); process.exit(2);
  }
},
phase(args) {
  const { flags, positional } = parseFlags(args);
  const [slug, phase] = positional;
  const root = flags.root ?? process.cwd();
  process.stdout.write(JSON.stringify(setPhase({ root, slug, phase }), null, 2) + '\n');
},
```

Helper (add near top of bb.mjs):
```js
function tryParseJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all 6 bashjson tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/bashjson.mjs scripts/bb.mjs tests/bashjson.test.mjs
git commit -m "feat: bash.json CRUD with whitelist + schema validation"
```

---

### Task 6: STATUS.md writer

**Files:**
- Create: `scripts/lib/statusmd.mjs`
- Create: `tests/statusmd.test.mjs`
- Modify: `scripts/bb.mjs` (add `status-md` subcommand)

- [ ] **Step 1: Write failing tests**

`tests/statusmd.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initBash } from '../scripts/lib/bashjson.mjs';
import { writeStatus, renderStatus } from '../scripts/lib/statusmd.mjs';

function mkroot() { return mkdtempSync(join(tmpdir(), 'bb-status-')); }

test('renderStatus: contains all fixed sections', () => {
  const md = renderStatus({
    title: 'Test bash', phase: 'ingest', status: 'Active — awaiting connector pick',
    narrative: 'Just started.', next: 'AskUserQuestion for connector selection.',
    pending: 'None', events: [{ ts: '2026-04-15T12:00:00Z', text: 'bash created' }],
  });
  assert.match(md, /^# Status — Test bash/m);
  assert.match(md, /\*\*Phase:\*\* ingest/);
  assert.match(md, /\*\*Status:\*\* Active — awaiting connector pick/);
  assert.match(md, /## Where we left off\nJust started\./);
  assert.match(md, /## Exact next action on resume\nAskUserQuestion for connector selection\./);
  assert.match(md, /## Phase progress\n- \[ \] Ingest\n- \[ \] Setup/);
  assert.match(md, /## Pending decisions \/ subagent runs\nNone/);
  assert.match(md, /## Recent events\n- 2026-04-15T12:00:00Z — bash created/);
});

test('renderStatus: phase progress reflects current phase', () => {
  const md = renderStatus({
    title: 't', phase: 'plan', status: 's', narrative: 'n', next: 'x', pending: 'None', events: [],
  });
  // ingest, setup, define all checked; plan+later unchecked
  assert.match(md, /- \[x\] Ingest\n- \[x\] Setup\n- \[x\] Define\n- \[ \] Plan/);
});

test('writeStatus: persists to .bb/<slug>/STATUS.md', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'T' });
  writeStatus({
    root, slug: 's1', phase: 'ingest', status: 'Active', narrative: 'n',
    next: 'x', pending: 'None', event: 'started',
  });
  const path = join(root, '.bb', 's1', 'STATUS.md');
  assert.ok(existsSync(path));
  const md = readFileSync(path, 'utf8');
  assert.match(md, /## Recent events\n- .+ — started/);
});

test('writeStatus: appends events on repeated calls', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'T' });
  writeStatus({ root, slug: 's1', phase: 'ingest', status: 'a', narrative: 'n', next: 'x', pending: 'None', event: 'one' });
  writeStatus({ root, slug: 's1', phase: 'ingest', status: 'a', narrative: 'n', next: 'x', pending: 'None', event: 'two' });
  const md = readFileSync(join(root, '.bb', 's1', 'STATUS.md'), 'utf8');
  const lines = md.match(/- .+ — (one|two)/g);
  assert.equal(lines.length, 2);
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test`
Expected: FAIL — missing module.

- [ ] **Step 3: Implement statusmd.mjs**

`scripts/lib/statusmd.mjs`:
```js
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PHASE_ORDER = ['ingest', 'setup', 'define', 'plan', 'execute', 'retest'];
const PHASE_LABELS = {
  ingest: 'Ingest', setup: 'Setup', define: 'Define', plan: 'Plan',
  execute: 'Execute', retest: 'Retest + Report',
};

export function renderStatus({ title, phase, status, narrative, next, pending, events }) {
  const currentIdx = phase === 'complete' ? PHASE_ORDER.length : PHASE_ORDER.indexOf(phase);
  const progress = PHASE_ORDER.map((p, i) =>
    `- [${i < currentIdx ? 'x' : ' '}] ${PHASE_LABELS[p]}`
  ).join('\n');
  const eventsBlock = events.length === 0
    ? '(none yet)'
    : events.map(e => `- ${e.ts} — ${e.text}`).join('\n');
  return [
    `# Status — ${title}`,
    '',
    `**Phase:** ${phase}`,
    `**Status:** ${status}`,
    '',
    '## Where we left off',
    narrative,
    '',
    '## Exact next action on resume',
    next,
    '',
    '## Phase progress',
    progress,
    '',
    '## Pending decisions / subagent runs',
    pending,
    '',
    '## Recent events',
    eventsBlock,
    '',
  ].join('\n');
}

function parseEvents(md) {
  const m = md.match(/## Recent events\n([\s\S]*?)(?:\n## |\n*$)/);
  if (!m) return [];
  return m[1].split('\n')
    .map(l => l.match(/^- (\S+) — (.+)$/))
    .filter(Boolean)
    .map(m => ({ ts: m[1], text: m[2] }));
}

export function writeStatus({ root, slug, phase, status, narrative, next, pending, event, title }) {
  const path = join(root, '.bb', slug, 'STATUS.md');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const events = parseEvents(existing);
  if (event) events.push({ ts: new Date().toISOString(), text: event });
  // keep last 20 events
  const trimmed = events.slice(-20);
  const resolvedTitle = title ?? (existing.match(/^# Status — (.+)$/m)?.[1] ?? slug);
  const md = renderStatus({
    title: resolvedTitle, phase, status,
    narrative, next, pending: pending ?? 'None', events: trimmed,
  });
  writeFileSync(path, md);
  return path;
}
```

- [ ] **Step 4: Add `status-md` subcommand**

In `scripts/bb.mjs`:
```js
import { writeStatus } from './lib/statusmd.mjs';

// handlers:
'status-md'(args) {
  const { flags, positional } = parseFlags(args);
  const [slug] = positional;
  const root = flags.root ?? process.cwd();
  const path = writeStatus({
    root, slug,
    phase: flags.phase,
    status: flags.status,
    narrative: flags.narrative ?? '',
    next: flags.next,
    pending: flags.pending,
    event: flags.event,
  });
  process.stdout.write(path + '\n');
},
```

Note: because `status-md` has a hyphen, the dispatcher lookup `handlers[sub]` already works with a string key. Verify with a CLI smoke run.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all 4 statusmd tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/statusmd.mjs scripts/bb.mjs tests/statusmd.test.mjs
git commit -m "feat: STATUS.md renderer and writer"
```

---

### Task 7: INDEX.md regeneration

**Files:**
- Create: `scripts/lib/indexmd.mjs`
- Create: `tests/indexmd.test.mjs`
- Modify: `scripts/bb.mjs` (add `index` subcommand)

- [ ] **Step 1: Write failing tests**

`tests/indexmd.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initBash, setPhase, updateBash } from '../scripts/lib/bashjson.mjs';
import { regenerateIndex } from '../scripts/lib/indexmd.mjs';

function mkroot() { return mkdtempSync(join(tmpdir(), 'bb-idx-')); }

test('index: empty root creates empty INDEX.md', () => {
  const root = mkroot();
  regenerateIndex({ root });
  const md = readFileSync(join(root, '.bb', 'INDEX.md'), 'utf8');
  assert.match(md, /# Bug bashes/);
  assert.match(md, /No active bashes\./);
});

test('index: lists active bashes in table', () => {
  const root = mkroot();
  initBash({ root, slug: 'auth-2026-04-15', title: 'Auth feature' });
  initBash({ root, slug: 'billing-2026-04-15', title: 'Billing' });
  regenerateIndex({ root });
  const md = readFileSync(join(root, '.bb', 'INDEX.md'), 'utf8');
  assert.match(md, /## Active/);
  assert.match(md, /auth-2026-04-15.*Auth feature.*ingest.*active/);
  assert.match(md, /billing-2026-04-15.*Billing.*ingest.*active/);
});

test('index: separates complete from active', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'S1' });
  initBash({ root, slug: 's2', title: 'S2' });
  updateBash({ root, slug: 's2', path: 'status', value: 'complete' });
  setPhase({ root, slug: 's2', phase: 'complete' });
  regenerateIndex({ root });
  const md = readFileSync(join(root, '.bb', 'INDEX.md'), 'utf8');
  assert.match(md, /## Active[\s\S]+s1/);
  assert.match(md, /## Complete[\s\S]+s2/);
});

test('index: ignores non-bash subdirs (archive/, etc.)', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'S1' });
  // archive/ and any dir without bash.json should be skipped
  mkdirSync(join(root, '.bb', 'archive'), { recursive: true });
  regenerateIndex({ root });
  const md = readFileSync(join(root, '.bb', 'INDEX.md'), 'utf8');
  assert.doesNotMatch(md, /\barchive\b.*active/);
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test`
Expected: FAIL — missing module.

- [ ] **Step 3: Implement indexmd.mjs**

`scripts/lib/indexmd.mjs`:
```js
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function regenerateIndex({ root }) {
  const bbDir = join(root, '.bb');
  mkdirSync(bbDir, { recursive: true });
  const entries = readdirSync(bbDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== 'archive')
    .map(e => join(bbDir, e.name, 'bash.json'))
    .filter(p => existsSync(p))
    .map(p => JSON.parse(readFileSync(p, 'utf8')));

  const active = entries.filter(b => b.status === 'active' || b.status === 'paused');
  const complete = entries.filter(b => b.status === 'complete');
  const abandoned = entries.filter(b => b.status === 'abandoned');

  const rowsFor = (list) =>
    list.length === 0
      ? '_None._'
      : [
          '| Slug | Title | Phase | Status | Created |',
          '|------|-------|-------|--------|---------|',
          ...list.map(b => `| ${b.slug} | ${b.title} | ${b.current_phase} | ${b.status} | ${b.created_at} |`),
        ].join('\n');

  const md = [
    '# Bug bashes',
    '',
    '## Active',
    active.length === 0 ? 'No active bashes.' : rowsFor(active),
    '',
    '## Complete',
    rowsFor(complete),
    '',
    '## Abandoned',
    rowsFor(abandoned),
    '',
  ].join('\n');
  const path = join(bbDir, 'INDEX.md');
  writeFileSync(path, md);
  return path;
}
```

- [ ] **Step 4: Add `index` subcommand**

In `scripts/bb.mjs`:
```js
import { regenerateIndex } from './lib/indexmd.mjs';

// handlers:
index(args) {
  const { flags } = parseFlags(args);
  const root = flags.root ?? process.cwd();
  process.stdout.write(regenerateIndex({ root }) + '\n');
},
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all 4 indexmd tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/indexmd.mjs scripts/bb.mjs tests/indexmd.test.mjs
git commit -m "feat: INDEX.md regeneration"
```

---

### Task 8: Archive-to-history

**Files:**
- Create: `scripts/lib/archive.mjs`
- Create: `tests/archive.test.mjs`
- Modify: `scripts/bb.mjs` (add `archive` subcommand)

- [ ] **Step 1: Write failing tests**

`tests/archive.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initBash } from '../scripts/lib/bashjson.mjs';
import { archiveToHistory } from '../scripts/lib/archive.mjs';

function mkroot() { return mkdtempSync(join(tmpdir(), 'bb-arch-')); }

test('archive: moves files into .history/<ts>/ preserving structure', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'S' });
  const dir = join(root, '.bb', 's1');
  writeFileSync(join(dir, 'context.md'), 'CTX');
  writeFileSync(join(dir, 'setup.md'), 'SETUP');
  mkdirSync(join(dir, 'findings'), { recursive: true });
  writeFileSync(join(dir, 'findings', 'F001.md'), 'FND');

  const histDir = archiveToHistory({ root, slug: 's1', files: ['context.md', 'setup.md', 'findings/F001.md'] });
  // histDir should exist under .history/<ts>/
  assert.ok(existsSync(histDir));
  assert.equal(readFileSync(join(histDir, 'context.md'), 'utf8'), 'CTX');
  assert.equal(readFileSync(join(histDir, 'setup.md'), 'utf8'), 'SETUP');
  assert.equal(readFileSync(join(histDir, 'findings', 'F001.md'), 'utf8'), 'FND');
  // originals gone
  assert.equal(existsSync(join(dir, 'context.md')), false);
  assert.equal(existsSync(join(dir, 'setup.md')), false);
  assert.equal(existsSync(join(dir, 'findings', 'F001.md')), false);
});

test('archive: refuses to move bash.json or STATUS.md', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'S' });
  assert.throws(() => archiveToHistory({ root, slug: 's1', files: ['bash.json'] }), /protected/);
  assert.throws(() => archiveToHistory({ root, slug: 's1', files: ['STATUS.md'] }), /protected/);
});

test('archive: error on missing file', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'S' });
  assert.throws(() => archiveToHistory({ root, slug: 's1', files: ['does-not-exist.md'] }), /not found/);
});

test('archive: two archive calls in tight succession go to distinct timestamp dirs', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'S' });
  writeFileSync(join(root, '.bb', 's1', 'a.md'), '1');
  writeFileSync(join(root, '.bb', 's1', 'b.md'), '2');
  const h1 = archiveToHistory({ root, slug: 's1', files: ['a.md'] });
  const h2 = archiveToHistory({ root, slug: 's1', files: ['b.md'] });
  assert.notEqual(h1, h2);
});

test('archive: partial failure is atomic — no files moved, no .history dir created', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'S' });
  writeFileSync(join(root, '.bb', 's1', 'a.md'), 'A');
  assert.throws(
    () => archiveToHistory({ root, slug: 's1', files: ['a.md', 'missing.md'] }),
    /not found/,
  );
  assert.equal(existsSync(join(root, '.bb', 's1', 'a.md')), true);
  assert.equal(existsSync(join(root, '.bb', 's1', '.history')), false);
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test`
Expected: FAIL — missing module.

- [ ] **Step 3: Implement archive.mjs**

`scripts/lib/archive.mjs`:
```js
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';

const PROTECTED = new Set(['bash.json', 'STATUS.md']);

function tsDir() {
  // filesystem-safe: colons and dot become dashes; random suffix guarantees uniqueness under tight succession
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  return `${ts}-${randomBytes(2).toString('hex')}`;
}

export function archiveToHistory({ root, slug, files }) {
  const bashDir = join(root, '.bb', slug);

  const pairs = [];
  for (const rel of files) {
    if (PROTECTED.has(rel) || PROTECTED.has(rel.split('/').pop())) {
      throw new Error(`protected file refused for archive: ${rel}`);
    }
    const src = join(bashDir, rel);
    if (!existsSync(src)) throw new Error(`not found: ${rel}`);
    pairs.push({ rel, src });
  }

  const histRoot = join(bashDir, '.history', tsDir());
  mkdirSync(histRoot, { recursive: true });
  for (const { rel, src } of pairs) {
    const dst = join(histRoot, rel);
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(src, dst);
  }
  return histRoot;
}
```

- [ ] **Step 4: Add `archive` subcommand**

In `scripts/bb.mjs`:
```js
import { archiveToHistory } from './lib/archive.mjs';

archive(args) {
  const { flags, positional } = parseFlags(args);
  const [slug, ...files] = positional;
  const root = flags.root ?? process.cwd();
  process.stdout.write(archiveToHistory({ root, slug, files }) + '\n');
},
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all 4 archive tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/archive.mjs scripts/bb.mjs tests/archive.test.mjs
git commit -m "feat: archive-to-history with protected-file guard"
```

---

### Task 9: Active-bash discovery for resume

**Files:**
- Create: `scripts/lib/active.mjs`
- Create: `tests/active.test.mjs`
- Modify: `scripts/bb.mjs` (add `active` subcommand)

- [ ] **Step 1: Write failing tests**

`tests/active.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initBash, updateBash } from '../scripts/lib/bashjson.mjs';
import { listActiveBashes } from '../scripts/lib/active.mjs';

function mkroot() { return mkdtempSync(join(tmpdir(), 'bb-act-')); }

test('active: empty returns []', () => {
  const root = mkroot();
  assert.deepEqual(listActiveBashes({ root }), []);
});

test('active: lists active only, alphabetical by slug', () => {
  const root = mkroot();
  initBash({ root, slug: 'b-one', title: 'B' });
  initBash({ root, slug: 'a-two', title: 'A' });
  initBash({ root, slug: 'c-three', title: 'C' });
  updateBash({ root, slug: 'c-three', path: 'status', value: 'complete' });
  const list = listActiveBashes({ root });
  assert.deepEqual(list.map(b => b.slug), ['a-two', 'b-one']);
});

test('active: paused bashes are NOT returned (resume wants only active)', () => {
  const root = mkroot();
  initBash({ root, slug: 's1', title: 'S' });
  updateBash({ root, slug: 's1', path: 'status', value: 'paused' });
  assert.deepEqual(listActiveBashes({ root }), []);
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test`
Expected: FAIL — missing module.

- [ ] **Step 3: Implement active.mjs**

`scripts/lib/active.mjs`:
```js
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function listActiveBashes({ root }) {
  const bbDir = join(root, '.bb');
  if (!existsSync(bbDir)) return [];
  return readdirSync(bbDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== 'archive')
    .map(e => join(bbDir, e.name, 'bash.json'))
    .filter(p => existsSync(p))
    .map(p => JSON.parse(readFileSync(p, 'utf8')))
    .filter(b => b.status === 'active')
    .sort((a, b) => a.slug.localeCompare(b.slug));
}
```

- [ ] **Step 4: Add `active` subcommand**

```js
import { listActiveBashes } from './lib/active.mjs';

active(args) {
  const { flags } = parseFlags(args);
  const root = flags.root ?? process.cwd();
  for (const b of listActiveBashes({ root })) process.stdout.write(b.slug + '\n');
},
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all 3 active tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/active.mjs scripts/bb.mjs tests/active.test.mjs
git commit -m "feat: active-bash discovery for resume"
```

---

### Task 10: Templates (batch 1 of 2) — pause-reminder, context, setup, scenario

**Files:**
- Create: `templates/pause-reminder.md`
- Create: `templates/context.md`
- Create: `templates/setup.md`
- Create: `templates/scenario.md`
- Create: `tests/templates.test.mjs`

- [ ] **Step 1: Write failing tests**

`tests/templates.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readTmpl(name) {
  return readFileSync(join(root, 'templates', name), 'utf8');
}

test('pause-reminder: contains required placeholders', () => {
  const t = readTmpl('pause-reminder.md');
  for (const ph of ['{phase_name}', '{slug}', '{artifact_file}', '{next_phase_name}']) {
    assert.ok(t.includes(ph), `missing placeholder ${ph}`);
  }
});

test('context.md: has the expected top-level sections', () => {
  const t = readTmpl('context.md');
  for (const h of ['# Context', '## Sources', '## Summary']) {
    assert.match(t, new RegExp(`^${h.replace(/\s/g, '\\s')}`, 'm'));
  }
});

test('setup.md: has env + preconditions sections', () => {
  const t = readTmpl('setup.md');
  for (const h of ['# Setup', '## Environment', '## Auth', '## Preconditions', '## Verification']) {
    assert.match(t, new RegExp(`^${h}`, 'm'));
  }
});

test('scenario.md: has the scenario shape', () => {
  const t = readTmpl('scenario.md');
  for (const h of ['## Sxx — <title>', '**Given:**', '**When:**', '**Then:**', '**Agent type:**']) {
    assert.ok(t.includes(h), `missing ${h}`);
  }
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test`
Expected: FAIL — templates missing.

- [ ] **Step 3: Create templates**

`templates/pause-reminder.md`:
```markdown
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

`templates/context.md`:
```markdown
# Context

> Phase 1 artifact. Assembled by connector subagents during Ingest.

## Sources
<!-- Each connector subagent appends its entry here. Format:
     ### <connector-id> — <brief source identifier>
     <compressed summary>
-->

## Summary
<!-- Main orchestrator writes a 2-4 sentence overall synthesis here after all
     connector subagents return. -->
```

`templates/setup.md`:
```markdown
# Setup

> Phase 2 artifact. Captured conversationally or inferred from repo.
> Human must confirm environment is ready before Phase 5 can dispatch agents.

## Environment
- **Base URL:** <e.g., http://localhost:3000>
- **Runtime:** <e.g., Node 20.x>
- **Env file:** <path, or "inline below">

## Auth
- **Mode:** <none / session-cookie / bearer-token / oauth>
- **Test credentials:** <how the agent obtains them>

## Preconditions
<!-- Shared state all scenarios assume: seeded data, enabled feature flags, etc. -->

## Verification
<!-- Concrete steps to confirm the env is actually ready. Orchestrator blocks on
     explicit human confirmation that these pass. -->
```

`templates/scenario.md`:
```markdown
## Sxx — <title>

**Given:** <initial state>
**When:** <action>
**Then:** <expected result>

**Agent type:** <browser | api | cli | generic>
**Notes:** <any test-specific hints or evidence to capture>
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all 4 template tests PASS.

- [ ] **Step 5: Commit**

```bash
git add templates/pause-reminder.md templates/context.md templates/setup.md templates/scenario.md tests/templates.test.mjs
git commit -m "feat: templates — pause-reminder, context, setup, scenario"
```

---

### Task 11: Templates (batch 2 of 2) — dispatch-plan, finding, report

**Files:**
- Create: `templates/dispatch-plan.md`
- Create: `templates/finding.md`
- Create: `templates/report.md`
- Modify: `tests/templates.test.mjs` (add cases)

- [ ] **Step 1: Extend failing tests**

Append to `tests/templates.test.mjs`:
```js
test('dispatch-plan.md: has Wave heading and fields', () => {
  const t = readTmpl('dispatch-plan.md');
  assert.match(t, /^## Dispatch Plan/m);
  assert.match(t, /### Wave \d+/);
  assert.ok(t.includes('- Agent type:'));
  assert.ok(t.includes('- Scenarios:'));
  assert.ok(t.includes('- Mode:'));
});

test('finding.md: has frontmatter keys and sections', () => {
  const t = readTmpl('finding.md');
  for (const key of ['id:', 'scenario:', 'agent_type:', 'severity:', 'status:', 'created_at:', 'retest_cycles:']) {
    assert.ok(t.includes(key), `missing frontmatter key ${key}`);
  }
  for (const h of ['## Summary', '## Scenario', '## Repro steps', '## Expected', '## Actual', '## Evidence', '## Notes']) {
    assert.match(t, new RegExp(`^${h}`, 'm'));
  }
});

test('report.md: has executive summary and findings-by-severity index', () => {
  const t = readTmpl('report.md');
  for (const h of ['## Executive summary', '## Scope', '## Findings — index by severity', '## Findings — detail',
                   '## Known issues / skipped', '## Retest summary', '## Recommended next steps', '## Artifacts']) {
    assert.match(t, new RegExp(`^${h}`, 'm'));
  }
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test`
Expected: FAIL — templates missing.

- [ ] **Step 3: Create templates**

`templates/dispatch-plan.md`:
```markdown
# Dispatch Plan

> Phase 4 artifact. Produced by the Plan-phase classifier subagent.

## Dispatch Plan

### Wave 1 — parallel, max concurrent <N>
- Agent type: <id>
- Scenarios: <S01, S02, ...>
- Mode: one-per-scenario | batched-serial

### Wave 2 — serial
- Agent type: <id>
- Scenarios: <S04, S05, ...>
- Mode: batched-serial

<!-- Add waves as needed. Each wave is a single agent type with a concurrency mode.
     Main orchestrator presents this plan, gets AskUserQuestion approval, then dispatches. -->

## Notes
<!-- Rationale for grouping choices, any scenarios left out and why, retry posture. -->
```

`templates/finding.md`:
```markdown
---
id: Fxxx
scenario: Sxx
agent_type: <id>
severity: high | medium | low
status: open | resolved | known
created_at: <ISO-8601>
retest_cycles: 0
---

# Fxxx — <title>

## Summary
<one paragraph>

## Scenario
<reference to Sxx, with link to scenarios.md>

## Repro steps
1. …
2. …

## Expected
<copied from scenarios.md>

## Actual
<what happened>

## Evidence
<!-- Links to files in findings/Fxxx-<slug>/evidence/ (binaries)
     and/or inline code blocks for short logs. -->

## Notes
<agent observations: timing, edge cases, environment specifics>
```

`templates/report.md`:
```markdown
---
bash_slug: <slug>
bash_title: <title>
completed_at: <ISO-8601>
duration: <human-readable>
connectors: [<ids>]
agent_types: [<ids>]
---

# Bug Bash Report — <title>

## Executive summary
<1–3 sentences: what was tested, how many scenarios, headline finding counts, overall verdict>

## Scope
- **Context sources:** <connectors used, with source refs>
- **Scenarios run:** <count> (<pass>/<fail>/<blocked>)
- **Setup:** <base URL, auth mode, key preconditions — copied from setup.md>
- **Agent types used:** <list with run counts>

## Findings — index by severity

### High (<N>)
- **Fxxx** — <title> · Sxx · <status> — [detail](#fxxx)

### Medium (<N>)
<same pattern>

### Low (<N>)
<same pattern>

## Findings — detail

### Fxxx — <title>
- **Severity:** <...> · **Status:** <...> · **Scenario:** Sxx · **Agent:** <id> · **Retest cycles:** <N>

**Repro steps:**
1. …

**Expected:** <...>
**Actual:** <...>

**Evidence:**
- [<label>](findings/Fxxx-<slug>/evidence/<file>)

**Notes:** <...>

**Retest history:**
- <ISO ts> — <attempt summary + result + evidence ref>

## Known issues / skipped
- **Fxxx** — marked known (<why>)
- **Sxx** — skipped (<why>)

## Retest summary
- Total retest cycles: <N>
- Scenarios re-run: <list>
- Criteria refinements: <list>

## Recommended next steps
<1–5 priority-ordered bullets>

## Artifacts
- Context: `.bb/<slug>/context.md`
- Setup: `.bb/<slug>/setup.md`
- Scenarios: `.bb/<slug>/scenarios.md`
- Dispatch plan: `.bb/<slug>/dispatch-plan.md`
- Findings: `.bb/<slug>/findings/`
- Retest log: `.bb/<slug>/retest-log.md`
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all 3 new template tests PASS; previously passing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add templates/dispatch-plan.md templates/finding.md templates/report.md tests/templates.test.mjs
git commit -m "feat: templates — dispatch-plan, finding, report"
```

---

### Task 12: Reference docs

**Files:**
- Create: `references/workflow-phases.md`
- Create: `references/setup-playbook.md`
- Create: `references/dispatch-playbook.md`
- Create: `references/retest-playbook.md`
- Create: `references/writing-connectors.md`
- Create: `tests/references.test.mjs`

- [ ] **Step 1: Write failing tests**

`tests/references.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readRef(name) { return readFileSync(join(root, 'references', name), 'utf8'); }

test('workflow-phases.md: covers all 6 phase names', () => {
  const t = readRef('workflow-phases.md');
  for (const p of ['Ingest', 'Setup', 'Define', 'Plan', 'Execute', 'Retest']) {
    assert.ok(t.includes(p), `missing phase ${p}`);
  }
});

test('setup-playbook.md: exists and is non-trivial', () => {
  assert.ok(statSync(join(root, 'references', 'setup-playbook.md')).size > 200);
});

test('dispatch-playbook.md: exists and is non-trivial', () => {
  assert.ok(statSync(join(root, 'references', 'dispatch-playbook.md')).size > 200);
});

test('retest-playbook.md: covers 4 dispositions', () => {
  const t = readRef('retest-playbook.md');
  for (const d of ['fix-and-retest', 'mark-known', 'refine-criteria', 'skip']) {
    assert.ok(t.includes(d), `missing disposition ${d}`);
  }
});

test('writing-connectors.md: covers contract shape', () => {
  const t = readRef('writing-connectors.md');
  for (const s of ['## When to use', '## Inputs', '## Dependencies', '## Pre-flight check', '## Fetch recipe', '## Output section', '## Setup steps']) {
    assert.ok(t.includes(s), `missing section ${s}`);
  }
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test`
Expected: FAIL — references missing.

- [ ] **Step 3: Create reference docs**

`references/workflow-phases.md`:
```markdown
# Workflow phases

The `/bb:run` orchestrator walks six phases, in order. Every phase has an artifact on disk and an explicit human-approval gate at its boundary.

| # | Phase   | Artifact                    | Gate question                          |
|---|---------|-----------------------------|----------------------------------------|
| 1 | Ingest  | `context.md`                | "Context complete?"                    |
| 2 | Setup   | `setup.md`                  | "Env actually ready?"                  |
| 3 | Define  | `scenarios.md`              | "Scenario list locked?"                |
| 4 | Plan    | `dispatch-plan.md`          | "Methodology approved?"                |
| 5 | Execute | `findings/*.md`             | (agents complete or halted)            |
| 6 | Retest  | `retest-log.md`, `report.md`| "Bash complete?"                       |

## Backtracking

Any phase boundary offers a backtrack option. Backtracking moves all downstream artifacts into `.history/<timestamp>/` — nothing is deleted.

## Pause reminders

After every phase, the orchestrator emits a pause-reminder block (see `templates/pause-reminder.md`). The reminder is loudest after Ingest (heavy reads) and Execute (many agent outputs).

## Resume mechanics

On `/bb:run` with no args:
1. Scans `.bb/*/bash.json` for `status: active` via `scripts/bb.mjs active`.
2. If one → reads that bash's `STATUS.md`, announces "Resuming `{slug}`. Last action: {exact next action}. Continue?"
3. If many → `AskUserQuestion` picker.
4. If none → starts a new bash.

The orchestrator resumes from the literal "exact next action" text in STATUS.md, never from a guess at phase state.
```

`references/setup-playbook.md`:
```markdown
# Setup playbook

The Setup phase (Phase 2) produces `setup.md` — the shared preconditions every agent needs before it can test anything. This playbook tells the orchestrator how to drive the phase.

## Two strategies — ask first

AskUserQuestion:
- **infer-from-repo**: Spawn a subagent that reads `.env.example`, `docker-compose.yml`, `package.json` scripts, and top-level `README.md`. The subagent produces a draft `setup.md` populated with what it could extract; anything uncertain it flags with `<!-- unclear -->`.
- **walk-through-manually**: Conversational capture. Orchestrator asks questions one at a time, writes directly into `setup.md`:
  1. Base URL?
  2. Runtime version?
  3. Auth mode? (none / session / bearer / oauth)
  4. How does a test agent obtain test credentials?
  5. Shared preconditions? (seeded data, feature flags, etc.)
  6. Verification steps the human will run to confirm env is up?
- **both**: run infer first, then walk through corrections.

## Hard gate — human confirms env is up

After `setup.md` is drafted, AskUserQuestion: "Env actually ready?" with options `yes` / `not yet — still setting up` / `revise setup.md`. Phase does not advance on `not yet`. This is Iron Law #9.

## Artifact

`setup.md` follows `templates/setup.md`. Orchestrator writes it; no subagent other than the optional infer agent touches it.
```

`references/dispatch-playbook.md`:
```markdown
# Dispatch playbook

The Plan phase (Phase 4) groups scenarios into dispatch waves. This playbook is what the Plan-phase classifier subagent is told to follow.

## Agent-type classification (per scenario)

```
Scenario touches UI (selectors, URL paths, rendered content)?  → browser
elif scenario hits an HTTP endpoint directly?                  → api
elif scenario invokes a shell / CLI command?                   → cli
else                                                           → generic
```

When ambiguous, default to `generic` and note the ambiguity.

## Wave construction

- Group scenarios sharing an agent type into a single wave.
- Within a wave, pick a **Mode**:
  - `one-per-scenario` — one subagent per scenario; full isolation. Use for browser scenarios (usually stateful) and API scenarios that mutate shared state.
  - `batched-serial` — one subagent runs the scenarios in sequence. Cheaper; fine for stateless API GETs, read-only CLI inspections.
- Cap parallel waves at `max_concurrent`. Default: 4.

## Why this matters

Wave structure defines blast radius. A bad plan that parallelizes mutating scenarios produces racy findings that don't reproduce. Err toward isolation.

## Artifact

`dispatch-plan.md` follows `templates/dispatch-plan.md`. Classifier subagent writes it; orchestrator reads it, presents to human, gets AskUserQuestion approval.
```

`references/retest-playbook.md`:
```markdown
# Retest playbook

The Retest loop (first half of Phase 6) walks each open finding and lets the human pick one of four dispositions. The orchestrator never auto-retests; disposition is always human-gated (Iron Law #8).

## Per-finding loop

For each finding with `status: open`:

1. **Spawn subagent**: "Read `findings/Fxxx` + originating scenario. Propose 2–4 retest strategies." Subagent returns a compact list (one-line each).

2. **AskUserQuestion** — four dispositions:

   | Option            | What happens                                                                        |
   |-------------------|-------------------------------------------------------------------------------------|
   | fix-and-retest    | Wait for human "fix is in" signal. Re-dispatch the single scenario agent. Update finding. Append to `retest-log.md`. Increment `retest_cycles` in bash.json. |
   | mark-known        | Set finding `status: known`. Log in `retest-log.md`. Move on.                       |
   | refine-criteria   | Backtrack to Define. Archive scenarios.md + dispatch-plan.md + findings for affected scenario. On return, re-execute the single scenario. |
   | skip              | Leave finding `status: open`. Log the skip reason in `retest-log.md`. Move on.      |

3. Update STATUS.md after each disposition.

## Human signals

- "fix is in" → re-dispatch. Never dispatch without this.
- "all done" → exit retest loop, move to report.

## Retest evidence

Per-finding retest evidence lives in `findings/Fxxx-<slug>/evidence/retest-N/` (numbered per cycle). Initial run evidence stays in `evidence/` root.
```

`references/writing-connectors.md`:
```markdown
# Writing connectors

Every connector lives at `connectors/<id>/<id>.md`. Fixed structure: YAML frontmatter + seven mandatory sections.

## Frontmatter

```yaml
---
id: <slug>                  # kebab; matches directory name
title: <display name>
version: <semver>
requires_mcp: <true|false>
auth_required: <true|false>
---
```

## Mandatory sections (fixed order)

## When to use
1–3 bullets. Drives human selection in Phase 1.

## Inputs the user must provide
Explicit list. What exactly does the human need to hand the subagent? (URL, ticket ID, file path, pasted text.)

## Dependencies
MCP servers, CLI tools, env vars, auth tokens. What must be installed for this connector to work?

## Pre-flight check
Deterministic check the orchestrator runs before dispatching. Returns one of `ready` / `needs-setup` / `unreachable`. Exact command(s) to run.

## Fetch recipe (subagent instructions)
Explicit step-by-step the dispatched connector subagent follows. Include failure paths: "if the URL 404s, return the error compactly and abort."

## Output section
The exact markdown heading + structure the subagent appends to `context.md`. Enables downstream agents to reason about source boundaries.

## Setup steps
Instructions `/bb:integration` uses to help install this connector (MCP registration, env var setup, auth flow, etc.). Required even if `requires_mcp: false` — can say "No setup needed."

## See also

- `connectors/README.md` — contract summary
- `connectors/integrations.md` — manifest row format
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all 5 references tests PASS.

- [ ] **Step 5: Commit**

```bash
git add references/ tests/references.test.mjs
git commit -m "feat: reference docs for phases, setup, dispatch, retest, connectors"
```

---

### Task 13: Connector contract doc + manifest

**Files:**
- Create: `connectors/README.md`
- Create: `connectors/integrations.md`
- Create: `tests/connectors-shape.test.mjs`

- [ ] **Step 1: Write failing tests**

`tests/connectors-shape.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('connectors/README.md: states the contract sections', () => {
  const t = readFileSync(join(root, 'connectors/README.md'), 'utf8');
  for (const s of ['## When to use', '## Inputs', '## Dependencies', '## Pre-flight check', '## Fetch recipe', '## Output section', '## Setup steps']) {
    assert.ok(t.includes(s), `contract section missing from README: ${s}`);
  }
});

test('connectors/integrations.md: manifest table has expected columns', () => {
  const t = readFileSync(join(root, 'connectors/integrations.md'), 'utf8');
  assert.match(t, /\|\s*ID\s*\|\s*Title\s*\|\s*Detail path\s*\|\s*When to use\s*\|\s*Needs setup\?\s*\|/);
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test`

- [ ] **Step 3: Create files**

`connectors/README.md`:
```markdown
# Connectors

Connectors ingest context in Phase 1 (Ingest). Each connector is a self-contained recipe that a dispatched subagent follows to pull content from one source type into `context.md`.

## Contract

Every connector lives at `connectors/<id>/<id>.md` with frontmatter + seven mandatory sections.

### Frontmatter
`id`, `title`, `version`, `requires_mcp`, `auth_required`.

### Sections (fixed order)
## When to use
## Inputs the user must provide
## Dependencies
## Pre-flight check
## Fetch recipe (subagent instructions)
## Output section
## Setup steps

See `references/writing-connectors.md` for the full spec and `templates/connector.md` (Plan B) for the authoring scaffold.

## Manifest

`connectors/integrations.md` is a one-row-per-connector table. The orchestrator reads only the manifest at startup, then reads a detail file only when its connector is actually selected.

## Ownership

- **Orchestrator**: reads manifest, runs pre-flight, dispatches subagents, reads assembled `context.md`.
- **Subagent**: reads only its recipe + user-supplied source, writes only its section in `context.md`, returns compact summary.
```

`connectors/integrations.md`:
```markdown
# Available Connectors

| ID    | Title        | Detail path                | When to use                             | Needs setup? |
|-------|--------------|----------------------------|-----------------------------------------|--------------|
| paste | Paste inline | connectors/paste/paste.md  | Ad-hoc — paste ticket/doc body in chat  | No           |
| code  | Local code   | connectors/code/code.md    | Source files, READMEs in the repo       | No           |
```

Note: `url`, `jira`, `gdocs` rows land in Plan B.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: both connectors-shape tests PASS.

- [ ] **Step 5: Commit**

```bash
git add connectors/README.md connectors/integrations.md tests/connectors-shape.test.mjs
git commit -m "feat: connector contract doc and manifest"
```

---

### Task 14: `paste` connector

**Files:**
- Create: `connectors/paste/paste.md`
- Create: `tests/connector-paste.test.mjs`

- [ ] **Step 1: Write failing tests**

`tests/connector-paste.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const [k, ...rest] = line.split(':');
    if (k) out[k.trim()] = rest.join(':').trim();
  }
  return out;
}

test('paste connector: frontmatter valid', () => {
  const md = readFileSync(join(root, 'connectors/paste/paste.md'), 'utf8');
  const fm = parseFrontmatter(md);
  assert.ok(fm, 'frontmatter missing');
  assert.equal(fm.id, 'paste');
  assert.equal(fm.requires_mcp, 'false');
  assert.equal(fm.auth_required, 'false');
  assert.match(fm.version, /^\d+\.\d+\.\d+$/);
});

test('paste connector: has all 7 contract sections', () => {
  const md = readFileSync(join(root, 'connectors/paste/paste.md'), 'utf8');
  for (const h of [
    '## When to use', '## Inputs the user must provide', '## Dependencies',
    '## Pre-flight check', '## Fetch recipe (subagent instructions)',
    '## Output section', '## Setup steps',
  ]) {
    assert.match(md, new RegExp(`^${h.replace(/[()]/g, '\\$&')}`, 'm'));
  }
});

test('paste connector: pre-flight says "ready" unconditionally', () => {
  const md = readFileSync(join(root, 'connectors/paste/paste.md'), 'utf8');
  assert.match(md, /returns:\s*ready/i);
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test`

- [ ] **Step 3: Create `connectors/paste/paste.md`**

```markdown
---
id: paste
title: Paste inline
version: 1.0.0
requires_mcp: false
auth_required: false
---

# Paste Connector

## When to use
- Ad-hoc context: a ticket body, a spec snippet, a paragraph from chat.
- Anything the human can copy-paste into the conversation.
- Fastest path — no fetching, no auth.

## Inputs the user must provide
- Raw text, pasted directly into the conversation.
- Optional: a short label ("ENG-1234 ticket body", "PRD excerpt") so the subagent can caption the section.

## Dependencies
None.

## Pre-flight check
No external system to check. Always returns: ready.

## Fetch recipe (subagent instructions)
1. Take the pasted content and the optional label as input.
2. If no label was provided, default to `Pasted content`.
3. Compress if the content is longer than ~1000 tokens: keep structure (headings, lists), drop boilerplate signatures, unchanged code blocks, etc. Otherwise keep verbatim.
4. Append the output section to `.bb/<slug>/context.md` using the format below.
5. Return a one-line summary: `paste: <label> (<n> chars raw / <m> kept)`.

## Output section
```markdown
### paste — <label>

<source text, compressed as needed, preserving structure>
```

## Setup steps
No setup needed. Always available.
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all 3 paste tests PASS.

- [ ] **Step 5: Commit**

```bash
git add connectors/paste/paste.md tests/connector-paste.test.mjs
git commit -m "feat: paste connector"
```

---

### Task 15: `code` connector

**Files:**
- Create: `connectors/code/code.md`
- Create: `tests/connector-code.test.mjs`

- [ ] **Step 1: Write failing tests**

`tests/connector-code.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  return Object.fromEntries(m[1].split('\n').map(l => {
    const i = l.indexOf(':');
    return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }).filter(([k]) => k));
}

test('code connector: frontmatter valid', () => {
  const md = readFileSync(join(root, 'connectors/code/code.md'), 'utf8');
  const fm = parseFrontmatter(md);
  assert.equal(fm.id, 'code');
  assert.equal(fm.requires_mcp, 'false');
  assert.equal(fm.auth_required, 'false');
});

test('code connector: has all 7 contract sections', () => {
  const md = readFileSync(join(root, 'connectors/code/code.md'), 'utf8');
  for (const h of [
    '## When to use', '## Inputs the user must provide', '## Dependencies',
    '## Pre-flight check', '## Fetch recipe (subagent instructions)',
    '## Output section', '## Setup steps',
  ]) {
    assert.match(md, new RegExp(`^${h.replace(/[()]/g, '\\$&')}`, 'm'));
  }
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test`

- [ ] **Step 3: Create `connectors/code/code.md`**

```markdown
---
id: code
title: Local code
version: 1.0.0
requires_mcp: false
auth_required: false
---

# Code Connector

## When to use
- The relevant context lives in the working repo: source files, README, tests, migrations.
- Useful paired with `paste`: the human pastes the ticket, this connector pulls the code it points at.

## Inputs the user must provide
- One or more file paths (absolute or relative to repo root).
- Optional: a line range (`src/auth/login.js:40-120`).
- Optional: a caption explaining why each file is relevant.

## Dependencies
None. Uses the Claude Code `Read` tool.

## Pre-flight check
For each provided path, confirm the file exists and is readable.
- All paths exist → returns: ready.
- Any path missing → returns: unreachable (list the missing paths).

## Fetch recipe (subagent instructions)
1. For each path:
   a. Read the file (respect line range if provided).
   b. If the file is > 500 lines and no range was given, return an error summary: "code: <path> too large; please provide a line range."
2. For each read, append an output block to `.bb/<slug>/context.md` using the format below. Preserve indentation. Wrap in a fenced code block with the file's language inferred from extension.
3. Return a one-line summary: `code: <N> files (<total lines>)`.

## Output section
````markdown
### code — <path>[:<start>-<end>]
<optional caption>

```<language>
<file contents>
```
````

## Setup steps
No setup needed. Always available in a Claude Code session with `Read` access.
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: both code tests PASS.

- [ ] **Step 5: Commit**

```bash
git add connectors/code/code.md tests/connector-code.test.mjs
git commit -m "feat: code connector"
```

---

### Task 16: Agent contract + manifest

**Files:**
- Create: `agents/README.md`
- Create: `agents/agents.md`
- Create: `tests/agents-shape.test.mjs`

- [ ] **Step 1: Write failing tests**

`tests/agents-shape.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('agents/README.md: states contract sections', () => {
  const t = readFileSync(join(root, 'agents/README.md'), 'utf8');
  for (const s of ['## When to use', '## Tools required', '## Pre-flight check', '## Test recipe', '## Evidence conventions', '## Failure handling']) {
    assert.ok(t.includes(s), `section missing from agents README: ${s}`);
  }
});

test('agents/agents.md: manifest table has expected columns', () => {
  const t = readFileSync(join(root, 'agents/agents.md'), 'utf8');
  assert.match(t, /\|\s*ID\s*\|\s*Title\s*\|\s*Detail path\s*\|\s*Use when\s*\|\s*Dependencies\s*\|/);
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test`

- [ ] **Step 3: Create files**

`agents/README.md`:
```markdown
# Agents

Agents execute scenarios in Phase 5 (Execute). Each agent type is a recipe that a dispatched subagent follows to test one or more scenarios and produce rich findings.

## Contract

Every agent type lives at `agents/<id>/<id>.md` with frontmatter + six mandatory sections.

### Frontmatter
`id`, `title`, `version`, `requires_mcp`, `mcp_servers` (array).

### Sections (fixed order)
## When to use
## Tools required
## Pre-flight check
## Test recipe (subagent instructions)
## Evidence conventions
## Failure handling

## Manifest

`agents/agents.md` is a one-row-per-agent-type table. The orchestrator reads only the manifest during Plan phase, then reads a detail file only when its agent type appears in the approved dispatch plan.

## Ownership

- **Orchestrator**: reads manifest, runs pre-flight per agent type used, dispatches subagents, tracks return counts only.
- **Subagent**: reads its recipe + `setup.md` + assigned scenarios, writes only under `findings/`, returns compact per-scenario summary.

## Adding a new agent type (v1)

Create `agents/<id>/<id>.md` by hand following the contract. Add a row to `agents/agents.md`. A command-driven flow is planned for a future version.
```

`agents/agents.md`:
```markdown
# Available Agent Types

| ID      | Title          | Detail path               | Use when                                  | Dependencies         |
|---------|----------------|---------------------------|-------------------------------------------|----------------------|
| api     | API tester     | agents/api/api.md         | Scenario hits an HTTP endpoint directly   | curl / http tooling  |
| generic | Generic tester | agents/generic/generic.md | Fallback when scenario doesn't fit above  | depends on scenario  |
```

Note: `browser` and `cli` rows land in Plan C.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: both agents-shape tests PASS.

- [ ] **Step 5: Commit**

```bash
git add agents/README.md agents/agents.md tests/agents-shape.test.mjs
git commit -m "feat: agent contract doc and manifest"
```

---

### Task 17: `generic` agent

**Files:**
- Create: `agents/generic/generic.md`
- Create: `tests/agent-generic.test.mjs`

- [ ] **Step 1: Write failing tests**

`tests/agent-generic.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? Object.fromEntries(m[1].split('\n').map(l => {
    const i = l.indexOf(':');
    return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }).filter(([k]) => k)) : null;
}

test('generic agent: frontmatter valid', () => {
  const md = readFileSync(join(root, 'agents/generic/generic.md'), 'utf8');
  const fm = parseFrontmatter(md);
  assert.equal(fm.id, 'generic');
  assert.equal(fm.requires_mcp, 'false');
});

test('generic agent: has all 6 contract sections', () => {
  const md = readFileSync(join(root, 'agents/generic/generic.md'), 'utf8');
  for (const h of ['## When to use', '## Tools required', '## Pre-flight check', '## Test recipe (subagent instructions)', '## Evidence conventions', '## Failure handling']) {
    assert.match(md, new RegExp(`^${h.replace(/[()]/g, '\\$&')}`, 'm'));
  }
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test`

- [ ] **Step 3: Create `agents/generic/generic.md`**

```markdown
---
id: generic
title: Generic tester
version: 1.0.0
requires_mcp: false
mcp_servers: []
---

# Generic Tester Agent

## When to use
- Scenario doesn't cleanly fit browser, api, or cli.
- Manual-verification-style checks (read-a-file, check-a-report, inspect-a-config).
- Fallback during Plan-phase classification when the other agent types aren't appropriate.

## Tools required
Read, Bash, Grep, Glob — standard Claude Code tools.

## Pre-flight check
Always returns: ready. This agent has no external dependencies.

## Test recipe (subagent instructions)
For each assigned scenario:
1. Read `setup.md` (it was passed into your prompt) to understand preconditions.
2. Interpret the scenario's Given/When/Then. If the required action is ambiguous, note the ambiguity in a finding with `severity: low, status: open` and move on.
3. Execute the action via available tools:
   - Files or logs: Read / Grep.
   - Shell inspection: Bash (read-only commands only — no mutation).
   - Search: Glob / Grep.
4. Compare observed behavior to the scenario's Then clause.
5. On mismatch, write a finding using `templates/finding.md` at `.bb/<slug>/findings/Fxxx-<short-slug>.md`:
   - Assign the next available `Fxxx` id by scanning the findings directory.
   - Severity: your judgment — `high` if the Then clause clearly fails, `medium` if partial, `low` for ambiguity.
   - Inline small evidence (log excerpts, config snippets) in the finding.
   - Binary or large evidence → save under `findings/Fxxx-<short-slug>/evidence/`.
6. On match (scenario passes), emit no finding; note pass in your return summary.

## Evidence conventions
- Short text (< 50 lines): inline in `## Evidence` section.
- Logs, stack traces, config dumps: save as separate file under `findings/Fxxx-<slug>/evidence/` and reference by relative path.
- Do not capture anything binary from this agent; route to the appropriate specialized agent instead.

## Failure handling
- Tool unavailable → return "scenario S<nn>: blocked — tool X unavailable" in your summary; do not create a finding.
- Ambiguous scenario wording → create a low-severity finding documenting the ambiguity.
- Any failure outside these cases → return a compact error summary; the orchestrator will decide.
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: both generic tests PASS.

- [ ] **Step 5: Commit**

```bash
git add agents/generic/generic.md tests/agent-generic.test.mjs
git commit -m "feat: generic agent"
```

---

### Task 18: `api` agent

**Files:**
- Create: `agents/api/api.md`
- Create: `tests/agent-api.test.mjs`

- [ ] **Step 1: Write failing tests**

`tests/agent-api.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? Object.fromEntries(m[1].split('\n').map(l => {
    const i = l.indexOf(':');
    return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }).filter(([k]) => k)) : null;
}

test('api agent: frontmatter valid', () => {
  const md = readFileSync(join(root, 'agents/api/api.md'), 'utf8');
  const fm = parseFrontmatter(md);
  assert.equal(fm.id, 'api');
  assert.equal(fm.requires_mcp, 'false');
});

test('api agent: recipe mentions curl', () => {
  const md = readFileSync(join(root, 'agents/api/api.md'), 'utf8');
  assert.match(md, /curl/);
});

test('api agent: has all 6 contract sections', () => {
  const md = readFileSync(join(root, 'agents/api/api.md'), 'utf8');
  for (const h of ['## When to use', '## Tools required', '## Pre-flight check', '## Test recipe (subagent instructions)', '## Evidence conventions', '## Failure handling']) {
    assert.match(md, new RegExp(`^${h.replace(/[()]/g, '\\$&')}`, 'm'));
  }
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test`

- [ ] **Step 3: Create `agents/api/api.md`**

```markdown
---
id: api
title: API tester
version: 1.0.0
requires_mcp: false
mcp_servers: []
---

# API Tester Agent

## When to use
- Scenario exercises an HTTP endpoint directly (REST, GraphQL, JSON-RPC).
- Request/response shape is part of the Then clause.
- No UI involved; fastest verification path.

## Tools required
Bash (curl), Read. Optionally jq for JSON post-processing.

## Pre-flight check
1. Run a lightweight health probe: `curl -sSf -o /dev/null -w "%{http_code}" "<base_url>/health"` (or `/` if no health endpoint). Base URL comes from `setup.md`.
2. Return ready if the probe returns any 2xx or 3xx; needs-setup if the probe fails to connect; unreachable on DNS/network error.

## Test recipe (subagent instructions)
For each assigned scenario:
1. Read `setup.md` (passed into prompt): extract base URL, auth mode, credentials mechanism.
2. Parse the scenario's Given/When/Then. Identify:
   - Method (GET/POST/PUT/DELETE)
   - Path
   - Headers (including Authorization if auth applies)
   - Request body (if any)
   - Expected status + response shape from the Then clause
3. Obtain auth credentials per `setup.md` (e.g., log in and capture bearer token).
4. Execute with curl. Capture full response: status, headers, body. Example:
   ```bash
   curl -sS -w "\n---HTTP %{http_code}---\n" \
     -H "Authorization: Bearer $TOKEN" \
     -X POST "$BASE_URL/api/widgets" \
     -d '{"name":"test"}' \
     -o response.body -D response.headers
   ```
5. Compare actual response to expected:
   - Status code mismatch → high severity.
   - Body shape mismatch (missing required field, wrong type) → medium severity.
   - Slow response (> 5s when scenario implies fast) → low severity.
6. On mismatch, write a finding using `templates/finding.md`:
   - Include full curl command (with secrets redacted) in Repro steps.
   - Include response status + headers + body excerpt in Evidence.
   - Save full response body as `findings/Fxxx-<slug>/evidence/response.body` if > 50 lines.
7. On match, emit no finding.

## Evidence conventions
- Request/response headers and small bodies inline in the finding.
- Full response bodies (> 50 lines or binary): `findings/Fxxx-<slug>/evidence/response.body`.
- Redact any secrets (Authorization header, API keys) with `<REDACTED>` before writing.

## Failure handling
- Pre-flight fails → return "scenario S<nn>: blocked — API unreachable" for every assigned scenario; do not create findings.
- Auth step fails → create one finding `F<xxx>` (severity high) describing the auth failure; skip remaining scenarios with a "blocked on auth" note in summary.
- curl timeout (> 30s) → create a finding with severity medium and note the timeout.
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all 3 api tests PASS.

- [ ] **Step 5: Commit**

```bash
git add agents/api/api.md tests/agent-api.test.mjs
git commit -m "feat: api agent"
```

---

### Task 19: `/bb:run` — entry logic + resume detection

**Files:**
- Create: `commands/run.md` (first iteration: entry + resume only; phases added in later tasks)
- Create: `tests/acceptance/run-resume.md` (manual walkthrough)

- [ ] **Step 1: Write the acceptance walkthrough first**

`tests/acceptance/run-resume.md`:
```markdown
# Acceptance: `/bb:run` entry + resume

## Preconditions
- Plugin installed locally via `/plugin install /Users/fredsun/Code/bb`.
- Working directory: any temp project dir (`mkdir /tmp/bb-test && cd /tmp/bb-test`).

## Scenario R1: No bashes, no args → start new
1. Delete any existing `.bb/` in cwd.
2. Run `/bb:run`.
3. Expect: "No active bashes. Describe the one you'd like to start."
4. Provide a title ("Test feature").
5. Expect: slug derived (`test-feature-<today>`), `.bb/test-feature-<today>/bash.json` created with phase=ingest, status=active, STATUS.md written, INDEX.md regenerated.

## Scenario R2: One active bash, no args → auto-resume
1. Start from R1 state.
2. `/clear`.
3. Run `/bb:run`.
4. Expect: "Resuming `test-feature-<today>`. Last action: <text from STATUS.md 'Exact next action'>. Continue?" with AskUserQuestion (yes / pick different / start new).
5. Pick "yes".
6. Expect: orchestrator jumps to that next action without re-asking phase questions.

## Scenario R3: Multiple active bashes → picker
1. Create a second bash manually: `node /Users/fredsun/Code/bb/scripts/bb.mjs init billing-<today> "Billing"`.
2. Run `/bb:run`.
3. Expect: AskUserQuestion multi-select picker listing both slugs with their titles and current phases. Select one.
4. Expect: orchestrator resumes the selected one.

## Scenario R4: Args provided → new bash regardless of existing active
1. State from R3 (two active bashes).
2. Run `/bb:run "Third thing"`.
3. Expect: new bash `third-thing-<today>` created without asking; existing bashes stay active.
```

- [ ] **Step 2: Create `commands/run.md` — entry + resume sections only**

`commands/run.md`:
```markdown
---
description: "Run a structured bug bash. No args = resume active bash; with args = start new."
---

# /bb:run — guided bug bash

You are the main orchestrator for a bug bash. Your job is to walk the six-phase workflow with the human, never auto-advancing gates, keeping context lean by delegating heavy work to subagents and the `bb` CLI.

All persistent state lives under `./.bb/<slug>/` in the user's working directory. You read and write through the CLI at `<plugin_root>/scripts/bb.mjs`. Deterministic operations (slug derivation, bash.json CRUD, STATUS.md/INDEX.md rendering, history archive, active-bash listing) go through the CLI — do NOT hand-edit bash.json or STATUS.md.

## Conventions (Iron Laws — non-negotiable)

1. No phase advances without explicit human AskUserQuestion approval.
2. You never ingest raw ticket/doc/code content directly — connector subagents do.
3. STATUS.md is write-through: update it before AND after every significant action (before spawning a subagent, after it returns, after every AskUserQuestion, on phase transitions).
4. Subagents have strict scope fences — always include "only write to <path>" in the prompt.
5. Backtracks archive, never delete. Use `bb archive` to move downstream artifacts to `.history/<ts>/`.
6. Pre-flight before dispatch. Run each connector's and agent's pre-flight check; surface failures explicitly.
7. Findings are always rich (template in `templates/finding.md`) — no binary pass/fail.
8. Retest disposition is always human-gated. Never auto-retest.
9. Setup phase blocks on explicit "env is ready" confirmation before any agent dispatch.
10. One active bash per `.bb/<slug>/`.

## Entry logic

1. **With args** (e.g. `/bb:run "Auth feature"`):
   - Derive slug: `node <plugin_root>/scripts/bb.mjs slug "<title>"` → capture stdout as slug.
   - Initialize: `node <plugin_root>/scripts/bb.mjs init "<slug>" "<title>"` (creates bash.json + .bb/<slug>/).
   - Write initial STATUS.md: `bb status-md <slug> --phase ingest --status "Active — starting Ingest" --next "AskUserQuestion for connector selection" --narrative "Bash just created." --event "bash created"`.
   - Regenerate INDEX: `bb index`.
   - Proceed to **Phase 1 — Ingest** (see `references/workflow-phases.md`).

2. **No args**:
   - List active: `bb active` → capture slug list.
   - **Zero active** → "No active bashes. Describe the one you'd like to start." Wait for title. Derive slug, init, proceed to Phase 1 as above.
   - **One active** → Read `.bb/<slug>/STATUS.md`. Announce: "Resuming `<slug>`. Last action: `<text from 'Exact next action on resume' section>`. Continue?" AskUserQuestion with options:
     - `yes` → proceed from that exact next action.
     - `pick different` → fall through to picker (treat as multi-active case).
     - `start new instead` → prompt for title.
   - **Multiple active** → AskUserQuestion with options built from `bb active` output. Each option shows slug + title (from its bash.json) + current phase. Selection determines resume target; then proceed as "one active" case.

## Phase routing after resume

Read the slug's bash.json with `bb json get <slug>`. Jump to the phase named in `current_phase`:

- `ingest` → Phase 1 section below
- `setup` → Phase 2
- `define` → Phase 3
- `plan` → Phase 4
- `execute` → Phase 5
- `retest` → Phase 6 retest loop
- `complete` → inform the human the bash is done; offer to view `report.md` or start a new bash

## Backtrack

At every phase boundary, the pause-reminder offers "continue / pause / backtrack". If the human picks backtrack:
1. AskUserQuestion: "Back to which phase?" — options are earlier phases only.
2. Collect list of artifacts to archive (everything downstream of the target phase — see `references/workflow-phases.md`).
3. `bb archive <slug> <files...>` to move them to `.history/<iso-ts>/`.
4. `bb phase <slug> <target-phase>` to set current_phase.
5. Update STATUS.md with narrative + next action.
6. Resume at the target phase.

## Phase 1 — Ingest

<!-- Added in Task 20 -->

## Phase 2 — Setup

<!-- Added in Task 21 -->

## Phase 3 — Define

<!-- Added in Task 22 -->

## Phase 4 — Plan

<!-- Added in Task 23 -->

## Phase 5 — Execute

<!-- Added in Task 24 -->

## Phase 6 — Retest + Report

<!-- Added in Task 25 -->
```

- [ ] **Step 3: Install plugin locally and run the R1–R4 walkthrough**

Commands (run interactively — not scripted):
```bash
cd /tmp && mkdir -p bb-test-r && cd bb-test-r
```
Then in Claude Code: `/plugin install /Users/fredsun/Code/bb`, then walk through `tests/acceptance/run-resume.md` scenarios R1–R4. Every expectation in the walkthrough must hold. If any fail, fix `commands/run.md` before committing.

Note the walkthrough doc assumes `<plugin_root>` resolves correctly inside the command — verify this is the case when Claude Code loads the markdown. If `<plugin_root>` needs to be a literal path, substitute it.

- [ ] **Step 4: Commit**

```bash
cd /Users/fredsun/Code/bb
git add commands/run.md tests/acceptance/run-resume.md
git commit -m "feat: /bb:run entry + resume + backtrack skeleton"
```

---

### Task 20: `/bb:run` — Phase 1 Ingest

**Files:**
- Modify: `commands/run.md` (fill in `## Phase 1 — Ingest` section)
- Create: `tests/acceptance/phase1-ingest.md`

- [ ] **Step 1: Write the acceptance walkthrough**

`tests/acceptance/phase1-ingest.md`:
```markdown
# Acceptance: Phase 1 — Ingest

## Preconditions
- Bash exists at phase `ingest`.
- `connectors/paste/paste.md` and `connectors/code/code.md` are on disk.

## Scenario I1: Pick paste connector only
1. Orchestrator reads `connectors/integrations.md` manifest, then runs AskUserQuestion: "Which connectors?" (multi-select) with paste, code visible.
2. Select paste only.
3. Orchestrator runs paste's pre-flight check — expects `ready`.
4. Orchestrator prompts for paste content + optional label.
5. Paste in: "This is a test ticket body about login bugs."
6. Orchestrator spawns one subagent with:
   - Full `connectors/paste/paste.md` content
   - Pasted text + label
   - Write target: `.bb/<slug>/context.md`
   - Scope fence: only write to that file
   - Return contract: one-line summary
7. Subagent returns a summary ("paste: <label> (<n> chars raw / <m> kept)").
8. Orchestrator reads `context.md`, shows it to human, AskUserQuestion: "Context complete? / add more / restart".
9. Select "Context complete?".
10. Expect: bash.json `current_phase` now `setup`; `connectors_used` now `[{id:"paste", version:"1.0.0"}]`; STATUS.md phase=setup with new next action; INDEX.md regenerated; pause-reminder printed.

## Scenario I2: Both connectors in parallel
1. Start fresh bash.
2. AskUserQuestion: multi-select → both `paste` and `code`.
3. For `code`: provide a file path (e.g. `README.md`).
4. Orchestrator runs each pre-flight. `code` returns `ready` because file exists.
5. Orchestrator spawns TWO subagents in parallel (one Task tool call with multiple content blocks — NOT sequential).
6. Both return compact summaries.
7. `context.md` contains two sections.
8. Gate approved.

## Scenario I3: Pre-flight failure (code connector, missing file)
1. Ask for the `code` connector with a path that doesn't exist.
2. Pre-flight returns `unreachable` listing the missing path.
3. Orchestrator surfaces the error and offers: retry with different path / cancel this connector / cancel phase.

## Scenario I4: "add more" re-runs ingest without losing existing context
1. From I1 after the subagent ran, pick "add more" instead of "Context complete?".
2. Orchestrator goes back to the AskUserQuestion for connector selection.
3. Pick `code`, provide a valid path.
4. Subagent runs, appends to existing `context.md` (does not overwrite).
5. Gate re-appears; approve.
6. Expect: `connectors_used` in bash.json now has both entries (paste and code).

## Scenario I5: "restart" archives context.md
1. From I1, pick "restart".
2. Expect: `bb archive <slug> context.md` called; new empty `context.md` seeded from `templates/context.md`; flow returns to connector selection.
3. `.bb/<slug>/.history/<ts>/context.md` holds the archived original.
```

- [ ] **Step 2: Fill in Phase 1 section in `commands/run.md`**

Replace the `## Phase 1 — Ingest` placeholder with:
```markdown
## Phase 1 — Ingest

**Goal:** Produce `.bb/<slug>/context.md` populated by connector subagents.

1. **Update STATUS.md** — `bb status-md <slug> --phase ingest --status "Active — selecting connectors" --next "AskUserQuestion for connector selection" --narrative "Entering Ingest." --event "entered ingest"`.

2. **Seed context.md if missing** — if `.bb/<slug>/context.md` doesn't exist, create it from `templates/context.md`.

3. **Load manifest** — Read `<plugin_root>/connectors/integrations.md`. Do NOT read individual detail files yet.

4. **AskUserQuestion** — options built from the manifest, one entry per row (label = `<id> — <title>`, description = the "When to use" column). Allow multi-select.

5. **For each selected connector**:
   a. Read its detail file (`connectors/<id>/<id>.md`).
   b. Parse its "Pre-flight check" section. Run the check. If `unreachable`: surface the failure to the human, AskUserQuestion: "retry / pick different / cancel this connector". Handle their choice before proceeding.
   c. If `needs-setup`: surface, offer "go set up then retry / pick different".
   d. If `ready`: prompt the human for the connector's required inputs (from "Inputs the user must provide" section).

6. **Dispatch subagents in parallel** — ONE Task tool call with multiple content blocks (one per connector). Each subagent prompt contains:
   - The full detail file text (the recipe)
   - The human-supplied source for that connector
   - "Write target: `.bb/<slug>/context.md`. Append your section under `## Sources`. Do NOT overwrite existing content."
   - "Scope fence: only write to that file."
   - "Return contract: one-line summary."

7. **After all subagents return** — update STATUS.md with event "ingest subagents returned: <N>". Read `.bb/<slug>/context.md` and show a compact summary (section headings only + the existing `## Summary` block if any) to the human.

8. **Write Summary** — synthesize a 2-4 sentence overall summary into the `## Summary` block of `context.md` yourself. This is the one time the orchestrator edits `context.md` directly. Do not include raw source content.

9. **AskUserQuestion — gate** — "Context complete?" with options: `yes, advance` / `add more connectors` / `restart ingest`.
   - `add more`: back to step 4 with the current connector set.
   - `restart`: `bb archive <slug> context.md`, seed a fresh one from template, back to step 4.
   - `yes, advance`: proceed.

10. **Record connectors used** — build an array `[{id, version}, ...]` from the frontmatter of each connector actually run. Call `bb json set <slug> connectors_used '<json>'`.

11. **Advance phase** — `bb phase <slug> setup`. Then `bb status-md <slug> --phase setup --status "Active — starting Setup" --next "AskUserQuestion: Setup strategy?" --narrative "Ingest complete; <N> connectors used." --event "advanced to setup"`. Then `bb index`.

12. **Emit pause reminder** — print `templates/pause-reminder.md` with placeholders filled in ({phase_name}=ingest, {slug}=<slug>, {artifact_file}=context.md, {next_phase_name}=setup).

13. **Continue / pause / backtrack?** — AskUserQuestion. On continue → Phase 2. On pause → "OK, state is safe in .bb/<slug>/. Run /bb:run to resume." On backtrack → backtrack flow (above).
```

- [ ] **Step 3: Run the acceptance walkthrough**

Execute `tests/acceptance/phase1-ingest.md` scenarios I1–I5. Fix any gaps in commands/run.md before committing.

- [ ] **Step 4: Commit**

```bash
git add commands/run.md tests/acceptance/phase1-ingest.md
git commit -m "feat: /bb:run Phase 1 Ingest"
```

---

### Task 21: `/bb:run` — Phase 2 Setup

**Files:**
- Modify: `commands/run.md` (fill in `## Phase 2 — Setup` section)
- Create: `tests/acceptance/phase2-setup.md`

- [ ] **Step 1: Write the acceptance walkthrough**

`tests/acceptance/phase2-setup.md`:
```markdown
# Acceptance: Phase 2 — Setup

## Preconditions
- Bash at phase `setup`.
- `templates/setup.md` on disk.

## Scenario S1: Walk-through-manually path
1. AskUserQuestion: "Setup strategy?" with options infer / manual / both.
2. Pick manual.
3. Orchestrator asks the 6 questions sequentially (base URL, runtime, auth mode, credentials path, preconditions, verification).
4. Answers populate setup.md sections per template.
5. AskUserQuestion: "Env actually ready?" with yes / not yet / revise.
6. Pick "not yet — still setting up".
7. Orchestrator pauses: "OK, resume with /bb:run when env is up. STATUS.md updated." Phase does NOT advance.
8. Confirm: `bash.json.current_phase` still `setup`; STATUS.md "exact next action" is the re-gate.

## Scenario S2: Confirm ready → advances to Define
1. From S1 state. Run /bb:run → auto-resume lands at the re-gate.
2. Pick "yes, ready".
3. Expect: phase advances to `define`, INDEX.md regenerated, pause reminder.

## Scenario S3: Infer-from-repo path
1. Fresh bash at phase setup. Project has a .env.example and package.json.
2. Pick "infer".
3. Orchestrator spawns subagent with:
   - setup.md template
   - "Read .env.example, package.json (scripts + engines), top-level README.md. Produce draft setup.md in .bb/<slug>/setup.md. Flag uncertain fields with <!-- unclear -->."
   - Scope fence: only setup.md
4. Subagent returns one-line summary.
5. Orchestrator reads setup.md back, shows to human, asks: "Revise before confirming?"
6. Revise conversationally → ready gate → advance.

## Scenario S4: Revise after draft
1. At the "Env ready?" gate, pick "revise".
2. Orchestrator conversationally walks through revisions, rewrites setup.md.
3. Re-gate. Confirm yes. Advance.
```

- [ ] **Step 2: Fill in Phase 2 section in commands/run.md**

Replace `## Phase 2 — Setup` with:
```markdown
## Phase 2 — Setup

**Goal:** Produce `.bb/<slug>/setup.md` capturing the shared preconditions every agent will need.

See `references/setup-playbook.md` for strategy details.

1. **Update STATUS.md** — event "entered setup".

2. **Seed setup.md if missing** — if `.bb/<slug>/setup.md` doesn't exist, create it from `templates/setup.md`.

3. **AskUserQuestion — strategy** — options: `infer-from-repo` / `walk-through-manually` / `both`.

4. **If infer or both** — spawn ONE subagent with:
   - `templates/setup.md` contents
   - "Read `.env.example`, `docker-compose*.y*ml` (if any), top-level `package.json`, top-level `README.md`. Produce a draft `.bb/<slug>/setup.md` populated from what you can extract. Flag uncertain fields with `<!-- unclear -->`."
   - Scope fence: "only write to `.bb/<slug>/setup.md`"
   - Return contract: "one-line summary of what you inferred"
   Update STATUS.md before and after the spawn.

5. **If manual or both** — ask the human the 6 questions conversationally, one at a time, writing each answer into the appropriate section of `setup.md`:
   1. Base URL?
   2. Runtime version?
   3. Auth mode? (none / session / bearer / oauth)
   4. How does a test agent obtain test credentials?
   5. Shared preconditions? (seeded data, feature flags, migrations)
   6. Verification steps?

6. **AskUserQuestion — hard gate** — "Env actually ready?" with options `yes, ready` / `not yet — still setting up` / `revise setup.md`.
   - `not yet`: update STATUS.md next action = "re-gate Env ready? in Phase 2 Setup"; print pause reminder; stop. Do NOT advance.
   - `revise`: loop back to step 5 (conversational revision).
   - `yes`: advance.

7. **Advance phase** — `bb phase <slug> define`, update STATUS.md, `bb index`, emit pause reminder.

8. **Continue / pause / backtrack?** — AskUserQuestion. Continue → Phase 3.
```

- [ ] **Step 3: Walkthrough**

Execute `tests/acceptance/phase2-setup.md` S1–S4.

- [ ] **Step 4: Commit**

```bash
git add commands/run.md tests/acceptance/phase2-setup.md
git commit -m "feat: /bb:run Phase 2 Setup"
```

---

### Task 22: `/bb:run` — Phase 3 Define

**Files:**
- Modify: `commands/run.md` (fill in `## Phase 3 — Define`)
- Create: `tests/acceptance/phase3-define.md`

- [ ] **Step 1: Acceptance walkthrough**

`tests/acceptance/phase3-define.md`:
```markdown
# Acceptance: Phase 3 — Define

## Preconditions
- Bash at phase `define`.
- `context.md` and `setup.md` exist and are non-trivial.

## Scenario D1: Draft + keep/edit/drop loop
1. Orchestrator conversationally captures acceptance criteria (asks the human in natural language).
2. Orchestrator spawns subagent: "Read context.md + setup.md + criteria. Draft 8-12 scenarios using templates/scenario.md. Write to scenarios.md. Scope fence: only scenarios.md. Return contract: one-line summary."
3. Subagent returns.
4. Orchestrator walks through each proposed scenario. For each: AskUserQuestion with keep / edit / drop / split.
   - edit → conversational refine, rewrite scenario block.
   - split → create two adjacent blocks, fill both.
   - drop → remove the block.
   - keep → move on.
5. Support adding net-new scenarios: orchestrator asks "add another scenario?" after the loop; if yes, capture Given/When/Then/Agent-type.
6. AskUserQuestion — "Scenario list locked?" → advance on yes.
7. Expect: bash.json current_phase = plan; STATUS.md updated; INDEX regenerated; pause reminder.

## Scenario D2: Drop all → restart draft
1. At step 4, drop every scenario.
2. Orchestrator offers: "No scenarios survive — redraft with different criteria, or add manually?" (AskUserQuestion).
3. Redraft path re-spawns the subagent; manual path goes straight to "add another" loop.
```

- [ ] **Step 2: Fill in Phase 3 section in commands/run.md**

Replace `## Phase 3 — Define`:
```markdown
## Phase 3 — Define

**Goal:** Produce `.bb/<slug>/scenarios.md` — the locked list of scenarios to execute.

1. **Update STATUS.md** — event "entered define".

2. **Seed scenarios.md if missing** — create from scratch with a single `# Scenarios` heading.

3. **Capture acceptance criteria** — conversational. "What does 'working' look like for this bash? Anything explicitly in or out of scope?" Record the criteria inline at the top of `scenarios.md` under `## Acceptance criteria`. This is an orchestrator-direct write — no subagent.

4. **Draft scenarios — spawn subagent** with:
   - `templates/scenario.md` contents
   - Full `context.md` and `setup.md` and the `## Acceptance criteria` section
   - "Draft 8–12 scenarios under a `## Scenarios` heading. One scenario per `## Sxx — <title>` block following the template. Use S01, S02, … numbering."
   - Scope fence: "only write to `.bb/<slug>/scenarios.md`"
   - Return contract: "one-line summary of scenario count and rough agent-type distribution"

5. **Per-scenario review loop** — for each Sxx in scenarios.md:
   a. Show the scenario block.
   b. AskUserQuestion: `keep` / `edit` / `drop` / `split`.
   c. `edit`: conversational refine. Rewrite the block in place.
   d. `drop`: delete the block; re-number remaining Sxx? No — keep the gap for traceability. (Sxx ids are stable once assigned.)
   e. `split`: "New titles for the two scenarios?" → create two new blocks with the next available Sxx ids, remove the original.

6. **Add net-new scenarios** — "Add another scenario?" loop. Each new one captured conversationally; appended with next Sxx id.

7. **Empty-set guard** — if all scenarios were dropped, AskUserQuestion: `redraft with different criteria` / `add manually only`. Don't advance with zero scenarios.

8. **AskUserQuestion — gate** — "Scenario list locked?" → yes / revise.

9. **Advance** — `bb phase <slug> plan`, update STATUS.md, `bb index`, pause reminder.

10. **Continue / pause / backtrack?**
```

- [ ] **Step 3: Walkthrough**

Execute `tests/acceptance/phase3-define.md`.

- [ ] **Step 4: Commit**

```bash
git add commands/run.md tests/acceptance/phase3-define.md
git commit -m "feat: /bb:run Phase 3 Define"
```

---

### Task 23: `/bb:run` — Phase 4 Plan

**Files:**
- Modify: `commands/run.md` (fill in `## Phase 4 — Plan`)
- Create: `tests/acceptance/phase4-plan.md`

- [ ] **Step 1: Acceptance walkthrough**

`tests/acceptance/phase4-plan.md`:
```markdown
# Acceptance: Phase 4 — Plan

## Preconditions
- Bash at phase `plan`.
- `scenarios.md` has at least 2 scenarios covering a mix of agent types.
- `agents/agents.md`, `agents/generic/generic.md`, `agents/api/api.md` exist.

## Scenario P1: Classifier produces dispatch plan; human approves
1. Orchestrator reads `agents/agents.md` manifest (NOT the detail files yet).
2. Spawns classifier subagent with:
   - scenarios.md contents
   - agents/agents.md manifest
   - templates/dispatch-plan.md
   - references/dispatch-playbook.md
   - "Classify each scenario by agent type, group into waves, choose Mode per wave. Write dispatch-plan.md. Scope fence: only that file. Return compact summary."
3. Subagent returns.
4. Orchestrator reads dispatch-plan.md, presents a human-readable summary: "Wave 1: generic×3 (S01–S03) one-per-scenario. Wave 2: api×2 (S04, S05) batched-serial. Max concurrent: 2."
5. AskUserQuestion — approve / modify / cancel.
6. Approve → advance.
7. Expect: phase=execute; STATUS.md reflects "dispatch plan approved"; pause reminder LOUDEST version.

## Scenario P2: Modify path
1. At P1 step 5, pick "modify".
2. Orchestrator asks: "What to change? (change wave structure / change agent type for scenario(s) / change mode / etc.)"
3. Handle modifications via conversational edits, rewrite dispatch-plan.md.
4. Re-present and re-gate.

## Scenario P3: Cancel path
1. At P1 step 5, pick "cancel".
2. Orchestrator: "Back up to Define or pause?" AskUserQuestion.
3. Back to Define → backtrack flow (archive dispatch-plan.md, bb phase <slug> define).
4. Pause → STATUS.md reflects pending cancellation decision; exit.
```

- [ ] **Step 2: Fill in Phase 4**

Replace `## Phase 4 — Plan`:
```markdown
## Phase 4 — Plan

**Goal:** Produce `.bb/<slug>/dispatch-plan.md` — approved wave + mode structure.

See `references/dispatch-playbook.md`.

1. **Update STATUS.md** — event "entered plan".

2. **Seed dispatch-plan.md if missing** — from `templates/dispatch-plan.md`.

3. **Spawn classifier subagent** with:
   - Full `.bb/<slug>/scenarios.md`
   - `<plugin_root>/agents/agents.md` (manifest only — NOT detail files)
   - `<plugin_root>/templates/dispatch-plan.md`
   - `<plugin_root>/references/dispatch-playbook.md`
   - "Classify each scenario by agent type using the playbook. Group into waves by type. Choose a Mode per wave: one-per-scenario or batched-serial. Default max_concurrent: 4. Write `.bb/<slug>/dispatch-plan.md`. Scope fence: only that file. Return one-line summary."

4. **Read dispatch-plan.md**. Synthesize a human-readable presentation: wave-by-wave, one line each.

5. **AskUserQuestion — gate** — `approve` / `modify` / `cancel`.
   - `modify`: ask what to change (wave grouping / agent type for specific scenarios / mode / max_concurrent). Apply the change directly to dispatch-plan.md. Re-present. Re-gate.
   - `cancel`: AskUserQuestion: `back to Define` / `pause bash`. `back to Define` → backtrack flow. `pause` → STATUS.md next action = "Decide plan cancellation path"; stop.
   - `approve`: advance.

6. **Advance** — `bb phase <slug> execute`, update STATUS.md with event "plan approved; dispatching soon", `bb index`.

7. **Pause reminder — LOUDEST** — include extra text: "Phase 5 will spawn agent subagents. Once they run, you'll have findings on disk. Good checkpoint to verify env state before firing."

8. **Continue / pause / backtrack?** — AskUserQuestion.
```

- [ ] **Step 3: Walkthrough**

Execute `tests/acceptance/phase4-plan.md`.

- [ ] **Step 4: Commit**

```bash
git add commands/run.md tests/acceptance/phase4-plan.md
git commit -m "feat: /bb:run Phase 4 Plan"
```

---

### Task 24: `/bb:run` — Phase 5 Execute

**Files:**
- Modify: `commands/run.md` (fill in `## Phase 5 — Execute`)
- Create: `tests/acceptance/phase5-execute.md`

- [ ] **Step 1: Acceptance walkthrough**

`tests/acceptance/phase5-execute.md`:
```markdown
# Acceptance: Phase 5 — Execute

## Preconditions
- Bash at phase `execute` with an approved dispatch-plan.md.
- `findings/` dir either absent or empty.
- At minimum one wave uses `generic` agent type.

## Scenario E1: Single-wave generic dispatch, one-per-scenario
1. Orchestrator reads dispatch-plan.md. For the first wave, reads `agents/generic/generic.md`.
2. Runs generic's pre-flight (returns ready unconditionally).
3. Spawns ONE subagent per scenario in parallel (one Task tool call with N content blocks). Each prompt contains:
   - `agents/generic/generic.md` full text
   - Full `.bb/<slug>/setup.md`
   - The specific scenario block (not all of scenarios.md)
   - Write target dir: `.bb/<slug>/findings/`
   - "Use `templates/finding.md`. Assign next available Fxxx by scanning the findings dir in your own ID choice; coordinate by reading existing files first."
   - Scope fence: only write under findings/
   - Return contract: "S<nn>: PASS | <N> findings (severity breakdown)"
4. Subagents return.
5. Orchestrator updates STATUS.md with counts ONLY (does not inline finding content).
6. Announce: "Wave 1 complete: 3 scenarios run, 2 findings open (1 high, 1 medium), 1 pass."
7. Proceed to next wave if any.

## Scenario E2: Batched-serial wave
1. Wave uses api agent, batched-serial mode.
2. Orchestrator spawns ONE subagent with all the wave's scenarios and instructions to run them in sequence.
3. Subagent returns a compact per-scenario summary.
4. Orchestrator records results.

## Scenario E3: Pre-flight failure for a wave
1. api agent's pre-flight returns unreachable (base URL not responding).
2. Orchestrator surfaces: "Wave 2 (api) pre-flight failed: <reason>. Options: retry / skip this wave / pause bash."
3. Retry → run pre-flight again, dispatch if ready.
4. Skip → mark the wave's scenarios as blocked in dispatch-plan.md (inline note), continue with remaining waves.
5. Pause → STATUS.md captures remaining waves as pending.

## Scenario E4: All waves complete → advance
1. After all waves finish, orchestrator runs `bb json set <slug> finding_counts '<json>'` with totals derived from reading `.bb/<slug>/findings/*.md` frontmatter.
2. Runs `bb json set <slug> dispatch_summary '<json>'` with agent run counts.
3. Advances to phase=retest.
4. Pause reminder — LOUDEST.

## Scenario E5: Finding ID collision guard
1. Two parallel subagents both try to claim F003.
2. Expected: agent subagents scan findings/ BEFORE writing and use the next free id. Orchestrator does a post-wave dedup scan — if two files claim the same id, orchestrator renumbers one and logs the event in STATUS.md. Note: this guard is best-effort; the primary defense is the one-per-scenario Mode (isolation) for stateful ID assignment, OR pre-assigning IDs from the orchestrator.
```

Given the ID-collision concern in E5 is real with parallel writes, we'll pre-assign IDs at dispatch time.

- [ ] **Step 2: Fill in Phase 5**

Replace `## Phase 5 — Execute`:
```markdown
## Phase 5 — Execute

**Goal:** Produce rich findings under `.bb/<slug>/findings/` by dispatching agent subagents per the approved dispatch plan.

1. **Update STATUS.md** — event "entered execute".

2. **Seed `.bb/<slug>/findings/`** if absent.

3. **Parse dispatch-plan.md** — extract waves in order. Each wave: agent type, scenarios, mode, concurrency.

4. **Pre-assign finding IDs** — before dispatching any subagent, count existing findings in the dir. Assign a unique `Fxxx` slot per scenario in this wave (placeholder id; the subagent uses it if it produces a finding). This eliminates parallel-ID collisions.

5. **For each wave, sequentially**:

   a. Read `agents/<type>/<type>.md`.

   b. Parse its "Pre-flight check" section. Run it. If not `ready`, AskUserQuestion: `retry` / `skip this wave` / `pause bash`. Skip marks each scenario in the wave as blocked in dispatch-plan.md with an inline `Blocked:` note; continue with next wave.

   c. **If Mode = one-per-scenario**: spawn N subagents in parallel (one Task tool call, N content blocks). Each prompt contains:
      - The agent detail file contents
      - Full `.bb/<slug>/setup.md`
      - The specific scenario's Sxx block (not all of scenarios.md)
      - The pre-assigned Fxxx slot to use if a finding is written
      - Write target dir: `.bb/<slug>/findings/` with filename `Fxxx-<kebab-scenario-title>.md`
      - "Use `templates/finding.md`. Evidence convention: large/binary under `findings/Fxxx-<slug>/evidence/`; short text inline."
      - Scope fence: "only write inside `.bb/<slug>/findings/`"
      - Return contract: "S<nn>: PASS | <N> findings (severity breakdown)"

   d. **If Mode = batched-serial**: spawn ONE subagent with the wave's entire scenario list and the same shape — "run them sequentially, write one finding per scenario failure."

   e. Await returns. Update STATUS.md with one event per return ("wave N scenario S<nn> returned").

6. **After all waves complete** — compute totals by reading frontmatter from `.bb/<slug>/findings/*.md`:
   - open = count where `status: open`
   - resolved = count where `status: resolved`
   - known = count where `status: known`
   - Call `bb json set <slug> finding_counts '{"open":X,"resolved":Y,"known":Z}'`.
   - Build dispatch_summary: `{agents_used: [{id, version, runs}, …]}` from observed waves.
   - Call `bb json set <slug> dispatch_summary '<json>'`.

7. **Announce counts** — "X scenarios run · Y findings open · Z passing. See `.bb/<slug>/findings/`." Do NOT inline finding content.

8. **Advance** — `bb phase <slug> retest`, update STATUS.md, `bb index`.

9. **Pause reminder — LOUDEST** — heaviest-pressure point.

10. **Continue / pause / backtrack?** — AskUserQuestion.
```

- [ ] **Step 3: Walkthrough**

Execute `tests/acceptance/phase5-execute.md`.

- [ ] **Step 4: Commit**

```bash
git add commands/run.md tests/acceptance/phase5-execute.md
git commit -m "feat: /bb:run Phase 5 Execute"
```

---

### Task 25: `/bb:run` — Phase 6 Retest + Report

**Files:**
- Modify: `commands/run.md` (fill in `## Phase 6 — Retest + Report`)
- Create: `tests/acceptance/phase6-retest-report.md`

- [ ] **Step 1: Acceptance walkthrough**

`tests/acceptance/phase6-retest-report.md`:
```markdown
# Acceptance: Phase 6 — Retest + Report

## Preconditions
- Bash at phase `retest` with at least 2 findings, at least 1 open.
- `retest-log.md` absent initially.

## Scenario RR1: fix-and-retest flow
1. Orchestrator reads findings/*.md frontmatter. For each open finding, loops.
2. Pick first open finding.
3. Spawns retest-suggester subagent: "Read this finding + its originating scenario. Propose 2-4 retest strategies." Returns compact list.
4. AskUserQuestion: fix-and-retest / mark-known / refine-criteria / skip.
5. Pick fix-and-retest.
6. Orchestrator: "Tell me when the fix is in (type 'fix is in')."
7. Human: "fix is in"
8. Orchestrator re-dispatches the single scenario's agent, writes new finding file into evidence/retest-1/ under the finding's directory, updates the finding's frontmatter (status, retest_cycles++), appends entry to retest-log.md.
9. Finding now shows updated status.

## Scenario RR2: mark-known
1. For a finding, pick mark-known.
2. Orchestrator asks: "Reason? (tracked in issue, low priority, known limitation)"
3. Updates finding status=known, appends to retest-log.md.

## Scenario RR3: refine-criteria
1. Pick refine-criteria.
2. Orchestrator: backtrack flow to Define. Archives dispatch-plan.md and the affected scenario's findings (NOT all of findings/ — just the ones tied to the scenario-to-revise).
3. Bash jumps to phase=define. Human revises scenario. Continues forward.

## Scenario RR4: skip
1. Pick skip. Log reason. Finding stays open. Loop continues.

## Scenario RR5: All findings handled → report
1. Loop exits when no open findings OR human says "all done" at any point.
2. AskUserQuestion: "Bash complete?" yes / not yet.
3. yes → spawn report subagent: "Read all findings/*.md, retest-log.md, scenarios.md, bash.json. Produce report.md using templates/report.md. Scope fence: only report.md. Return compact summary."
4. Orchestrator reads report.md (the one heavy read it does, at terminal step).
5. Updates bash.json: status=complete, current_phase=complete.
6. Regenerates STATUS.md as final snapshot.
7. Regenerates INDEX.md (bash moves to Complete section).
8. AskUserQuestion: archive now / leave active / start new bash.
9. Archive → move .bb/<slug>/ to .bb/archive/<slug>/. INDEX regenerated.
```

- [ ] **Step 2: Fill in Phase 6**

Replace `## Phase 6 — Retest + Report`:
```markdown
## Phase 6 — Retest + Report

**Goal:** Resolve each open finding by human-gated retest, then produce `.bb/<slug>/report.md`.

See `references/retest-playbook.md`.

### Retest loop

1. **Seed `.bb/<slug>/retest-log.md`** if absent — single `# Retest log` heading.

2. **Identify open findings** — list all findings under `.bb/<slug>/findings/*.md` with `status: open` (parse frontmatter).

3. **For each open finding**:

   a. Update STATUS.md — event "retest loop: considering <Fxxx>".

   b. Spawn retest-suggester subagent:
      - "Read `.bb/<slug>/findings/<file>` and the originating scenario from `.bb/<slug>/scenarios.md`."
      - "Propose 2–4 concrete retest strategies (one line each)."
      - Scope fence: "do not write any files"
      - Return contract: the bulleted list

   c. **AskUserQuestion** — `fix-and-retest` / `mark-known` / `refine-criteria` / `skip`.

   d. **fix-and-retest**:
      - "Tell me when the fix is in. Type 'fix is in' to proceed."
      - Wait for the exact signal. No auto-retest.
      - Compute retest cycle number N by reading existing `evidence/retest-*` dirs of this finding.
      - Re-dispatch the scenario's agent:
        - Use the scenario's `Agent type` to pick the right `agents/<id>/<id>.md`.
        - Subagent writes a fresh finding-style record into `findings/<Fxxx>-<slug>/evidence/retest-N/result.md`.
        - "Do not overwrite the original finding file; compare your result to it."
      - Orchestrator: update the original finding's frontmatter — `status: resolved` if retest passes, else keep `open` with `retest_cycles` incremented.
      - Append an entry to `retest-log.md`: `- <ts> — <Fxxx> — retest N — <result summary>`.
      - Update `bash.json`: `bb json set <slug> retest_cycles <incremented>`.

   e. **mark-known**:
      - Ask reason conversationally.
      - Update finding frontmatter: `status: known`.
      - Append to `retest-log.md`: `- <ts> — <Fxxx> — marked known — <reason>`.

   f. **refine-criteria**:
      - Enter backtrack flow to `define`.
      - Archive: `dispatch-plan.md` + the finding(s) tied to the affected scenario only (NOT all of findings/).
      - `bb phase <slug> define`.
      - Jump to Phase 3 from the scenario-editing loop.
      - After Define completes, Plan subagent re-runs for the changed scenario only; Execute dispatches just that scenario; loop back to Retest.

   g. **skip**:
      - Ask reason.
      - Append to `retest-log.md`: `- <ts> — <Fxxx> — skipped — <reason>`.
      - Leave `status: open`.

4. **Exit loop** when no findings remain open OR the human says "all done" (AskUserQuestion: "continue loop / all done" at each iteration). Update STATUS.md.

### Report

5. **AskUserQuestion — Bash complete?** `yes, generate report` / `not yet — more retest`.

6. **Spawn report subagent**:
   - "Read `.bb/<slug>/scenarios.md`, `.bb/<slug>/retest-log.md`, `.bb/<slug>/bash.json`, and EVERY file in `.bb/<slug>/findings/*.md` (full contents — this is the terminal synthesis)."
   - "List evidence directories for each finding (via `ls` / Glob) and link them via relative paths; do not read binary files."
   - `templates/report.md` contents
   - Write target: `.bb/<slug>/report.md`
   - Scope fence: only report.md
   - Return contract: compact one-paragraph summary

7. **Read `.bb/<slug>/report.md`** — the single heavy read the orchestrator does at terminal.

8. **Finalize state**:
   - `bb json set <slug> status complete`
   - `bb phase <slug> complete`
   - `bb status-md <slug> --phase complete --status "Bash complete" --next "Bash finished. Reference: .bb/<slug>/report.md" --narrative "<1-line verdict>" --event "bash complete"`
   - `bb index`

9. **AskUserQuestion** — `archive now` / `leave active` / `start new bash`.
   - `archive now`: move `.bb/<slug>/` → `.bb/archive/<slug>/`; `bb index`.
   - `leave active`: no move; INDEX already shows it in Complete section.
   - `start new bash`: prompt for new title, jump to entry logic as if `/bb:run "<title>"`.
```

- [ ] **Step 3: Walkthrough**

Execute `tests/acceptance/phase6-retest-report.md`.

- [ ] **Step 4: Commit**

```bash
git add commands/run.md tests/acceptance/phase6-retest-report.md
git commit -m "feat: /bb:run Phase 6 Retest + Report"
```

---

### Task 26: Top-level README for `/plugin` installation

**Files:**
- Modify: `README.md` (currently a 5-byte stub)
- Create: `tests/readme.test.mjs`

- [ ] **Step 1: Write failing test**

`tests/readme.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('README: covers install, usage, and the two commands', () => {
  const md = readFileSync(join(root, 'README.md'), 'utf8');
  assert.match(md, /^# bb/m);
  assert.match(md, /## Install/);
  assert.match(md, /\/plugin install/);
  assert.match(md, /## Usage/);
  assert.match(md, /\/bb:run/);
  assert.match(md, /\/bb:integration/); // mentioned as "coming in Plan B" OK
  assert.match(md, /## Requirements/);
  assert.match(md, /Node/);
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test`

- [ ] **Step 3: Write `README.md`**

```markdown
# bb — Bug bash plugin for Claude Code

Structured bug-bash workflow that walks from context ingest through agent-driven scenario testing to a final report. Every phase is human-gated; every scenario produces a rich finding; all state persists so a bash survives `/clear` and resumes on demand.

## Install

Local install (from a clone):
```
/plugin install /path/to/bb
```

Requires Node 20+ on PATH (the plugin's `scripts/bb.mjs` CLI is invoked during runtime).

## Usage

### `/bb:run` — guided bug bash

```
/bb:run                  # resume any active bash, or start new if none
/bb:run "Auth feature"   # start a new bash with that title
```

Drives six phases:

1. **Ingest** — pick connectors, pull context → `context.md`
2. **Setup** — env, auth, preconditions → `setup.md`
3. **Define** — acceptance criteria + scenarios → `scenarios.md`
4. **Plan** — adaptive agent dispatch → `dispatch-plan.md`
5. **Execute** — agents run scenarios → `findings/*.md`
6. **Retest + Report** — human-gated retest loop → `report.md`

All state lives under `.bb/<slug>/` in your current working directory. Every phase ends with an explicit approval gate. Backtracks archive (never delete) affected artifacts to `.bb/<slug>/.history/<ts>/`.

### `/bb:integration` — connector install & authoring

_Coming in a follow-up release. (Plan B.)_

## Connectors (v0.1)

- `paste` — paste a ticket / doc body inline.
- `code` — read local source files into context.

## Agent types (v0.1)

- `generic` — fallback; uses Read/Bash/Grep to verify scenarios.
- `api` — HTTP endpoint testing via curl.

`browser` and `cli` agent types are coming in a follow-up release. (Plan C.)

## Requirements

- Claude Code with plugin support.
- Node 20+.
- Deps (installed automatically): `ajv`, `ajv-formats` (for bash.json schema validation).

## Development

```
npm install
npm test
```

Tests are a mix of mechanical (`node --test`) and manual acceptance walkthroughs in `tests/acceptance/`.

## Layout

```
bb/
├── .claude-plugin/plugin.json
├── commands/run.md                    # /bb:run orchestrator
├── connectors/                        # context ingesters
│   ├── integrations.md                # manifest
│   └── <id>/<id>.md                   # one detail file per connector
├── agents/                            # scenario testers
│   ├── agents.md                      # manifest
│   └── <id>/<id>.md                   # one detail file per agent type
├── templates/                         # artifact shapes
├── references/                        # playbooks the orchestrator cites
└── scripts/bb.mjs                     # utility CLI
```

## License

MIT.
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: readme test PASSes; all prior tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md tests/readme.test.mjs
git commit -m "docs: README with install + usage"
```

---

### Task 27: End-to-end acceptance walkthrough

**Files:**
- Create: `tests/acceptance/end-to-end.md`

- [ ] **Step 1: Write the E2E walkthrough**

`tests/acceptance/end-to-end.md`:
```markdown
# Acceptance: End-to-end smoke

A single happy-path walkthrough exercising all six phases with both connectors and the generic agent. Run interactively with Fred.

## Setup
```
cd /tmp && rm -rf bb-e2e && mkdir bb-e2e && cd bb-e2e
echo "PORT=3000" > .env.example
echo '{"scripts":{"start":"node server.js"},"engines":{"node":">=20"}}' > package.json
echo "# Demo project" > README.md
# fake source file for code connector
mkdir -p src
echo "export function login() { return { ok: false }; }" > src/login.js
```

In Claude Code:
```
/plugin install /Users/fredsun/Code/bb
```

## Phase 1 — Ingest
```
/bb:run "Demo login bug"
```
- Slug derived: `demo-login-bug-<today>`.
- Select both paste + code connectors.
- For paste: label = "Ticket ENG-777", body = "Login returns 403 unexpectedly after refresh. Repro: log in, wait, refresh."
- For code: path = `src/login.js`.
- After subagents return, `.bb/demo-login-bug-<today>/context.md` has two `### paste —` / `### code —` sections under `## Sources` plus a 2–4 sentence `## Summary` block you wrote.
- Gate: "Context complete?" → yes.
- Expect: phase=setup, STATUS.md updated, INDEX.md shows the bash.

## Phase 2 — Setup
- Strategy: "infer-from-repo".
- Subagent reads .env.example + package.json + README.md, drafts setup.md.
- Revise fields you care about (base URL = http://localhost:3000, auth = none).
- Gate: "Env actually ready?" → not yet (run `/clear` to test resume).
- Run `/bb:run` → auto-resume lands back at the "Env ready?" gate.
- This time pick "yes, ready". Phase=define.

## Phase 3 — Define
- Criteria: "login works; refresh doesn't drop session; error responses match spec".
- Draft subagent produces ~8 scenarios.
- Walk through: keep most, edit one ("be more specific about the refresh case"), drop any that don't fit the demo repo, add one more manually.
- Gate: yes. Phase=plan.

## Phase 4 — Plan
- Classifier subagent produces dispatch-plan.md.
- All scenarios land under `generic` since there's no real API to hit. (Or if the classifier picks `api`, skip-on-preflight will handle it in Phase 5.)
- Approve. Phase=execute.

## Phase 5 — Execute
- Pre-assign Fxxx slots.
- Dispatch generic wave.
- Subagents inspect `src/login.js` via Read, note that login returns `{ok: false}` unconditionally, open findings describing the mismatch.
- After wave, finding_counts and dispatch_summary written to bash.json.
- Phase=retest.

## Phase 6 — Retest + Report
- Walk through open findings:
  - F001: fix-and-retest. Edit `src/login.js` to `return { ok: true };`. Say "fix is in". Single-scenario redispatch. Finding should flip to resolved.
  - F002: mark-known (pretend we have a tracked ticket).
  - Others: skip.
- Say "all done".
- Gate: bash complete? → yes.
- Report subagent produces report.md.
- Read report.md: verify it has executive summary, severity-grouped findings, retest history, artifacts section.
- Gate: archive now → yes.
- Expect: `.bb/archive/demo-login-bug-<today>/` exists; INDEX.md shows no active bashes.

## Check afterwards
```
cd /Users/fredsun/Code/bb
npm test
```
All mechanical tests still pass.
```

- [ ] **Step 2: Run the walkthrough end-to-end**

Execute all of it interactively. Any deviation between expected and actual is a bug — fix, re-run that step, and only proceed when the whole sequence is clean.

- [ ] **Step 3: Commit**

```bash
git add tests/acceptance/end-to-end.md
git commit -m "test: end-to-end acceptance walkthrough"
```

---

### Task 28: Final sweep — run all tests + smoke install

**Files:** none (verification only)

- [ ] **Step 1: All mechanical tests**

Run: `cd /Users/fredsun/Code/bb && npm test`
Expected: every test file PASSes; zero skipped.

- [ ] **Step 2: Smoke-check each CLI subcommand via `--help` / usage messages**

Run each with no args to confirm usage prints and exits non-zero:
```
for cmd in slug init json phase status-md index archive active validate; do
  node scripts/bb.mjs $cmd
  echo "---"
done
```
Expected: each prints a usage line and exits ≠ 0.

- [ ] **Step 3: Verify plugin install works**

```
cd /tmp && rm -rf bb-final && mkdir bb-final && cd bb-final
```
In Claude Code: `/plugin install /Users/fredsun/Code/bb` — expect success.

`/bb:run` with no args should say "No active bashes. Describe the one you'd like to start."

- [ ] **Step 4: Tag v0.1.0**

```bash
cd /Users/fredsun/Code/bb
git tag v0.1.0
```

- [ ] **Step 5: Final commit if anything was touched during sweep**

```bash
git status   # expect clean
```
If not clean, fix and commit. Then the plan is done.

---

## Self-review

### Spec coverage
- §1 Top-level shape: covered (`/bb:run` built Tasks 19–25; `/bb:integration` explicitly Plan B).
- §2 Directory layout + bash.json + STATUS.md + pause reminders + resume: Tasks 2, 5, 6, 10, 19.
- §2.5 Orchestrator-vs-subagent split: embedded throughout Phase tasks 20–25 as Iron Laws and subagent prompts.
- §3 Phase walk-through: Tasks 19–25.
- §4 Connector contract + manifest + pre-flight + versioning + ownership: Tasks 13–15 + enforced in Phase 1 (Task 20). Connector-authoring (`/bb:integration`) explicitly Plan B.
- §5 Agent prompt contract: Tasks 16–18 + enforced in Phase 5 (Task 24). Browser + CLI agents Plan C.
- §6 Iron laws + hard gates: Iron Laws listed in `commands/run.md` (Task 19); hard gates embedded in each phase task.
- §7 Report format + evidence lifecycle: template (Task 11) + Phase 6 (Task 25); bundle-for-sharing is Plan C.

### Placeholder scan
- No "TBD" / "TODO" / "implement later" in steps.
- No "similar to Task N" hand-waving.
- Every code step has actual code; every command step has the exact command + expected output.

### Type consistency
- Slug format: kebab + ISO date + numeric suffix on collision, same in Task 3 tests, Cross-cutting section, and Phase 1 docs.
- bash.json field names consistent (`current_phase`, `status`, `connectors_used`, `dispatch_summary`, `finding_counts`, `retest_cycles`) across Tasks 4, 5, 7, 9, 20, 24, 25.
- CLI subcommand names consistent (`slug`, `init`, `json get/set`, `phase`, `status-md`, `index`, `archive`, `active`, `validate`) between Cross-cutting, implementations (Tasks 3–9), and orchestrator calls (Tasks 19–25).
- STATUS.md sections consistent (renderStatus in Task 6, phase ordering `ingest|setup|define|plan|execute|retest`).
- Connector contract: 7 sections, same names in references/writing-connectors (Task 12), README (Task 13), paste/code (Tasks 14–15), shape tests.
- Agent contract: 6 sections, same names in README (Task 16), generic/api (Tasks 17–18).
- `Fxxx` id format stable; pre-assignment in Phase 5 (Task 24) prevents parallel collision.
