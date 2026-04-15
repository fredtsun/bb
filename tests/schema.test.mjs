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
