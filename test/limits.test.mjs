import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Source-contract test: the knobs must stay env-wired with the raised defaults.
// (The extension tree is TS loaded by pi; node tests assert the wiring instead of importing it.)
const src = readFileSync(new URL('../lib/contract.ts', import.meta.url), 'utf8');
test('budget/pending limits are env-overridable with raised defaults', () => {
  assert.match(src, /PI_CROSS_SESSION_BUDGET",\s*2048,\s*1/, 'budget default 2048, min 1');
  assert.match(src, /PI_CROSS_SESSION_MAX_PENDING",\s*200,\s*1/, 'pending default 200, min 1');
  assert.match(src, /function envInt/, 'shared parser exists');
});
test('extension consumes the shared limits, no local hardcode', () => {
  const ext = readFileSync(new URL('../extensions/cross-session.ts', import.meta.url), 'utf8');
  assert.match(ext, /TOTAL_BUDGET, MAX_PENDING/);
  assert.doesNotMatch(ext, /const (TOTAL_BUDGET|MAX_PENDING) = \d/);
});
