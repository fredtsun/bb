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
