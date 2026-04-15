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
