import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareCoverage, coveragePercentage, METRICS, renderSummary } from './check-coverage-regression.mjs';

const summary = (covered, total = 100) => ({
  total: Object.fromEntries(METRICS.map((name) => [name, { covered, total }])),
});

test('calculates exact coverage percentages from counts', () => {
  assert.equal(coveragePercentage({ covered: 1, total: 3 }), 100 / 3);
});

test('no decline against main passes', () => {
  const rows = compareCoverage(summary(80), summary(80));
  assert.ok(rows.every((row) => row.passed));
  assert.ok(rows.every((row) => row.deltaPP === 0));
});

test('a 0.50 percentage-point decline passes the configured tolerance', () => {
  const rows = compareCoverage(summary(795, 1000), summary(800, 1000), 0.5);
  assert.ok(rows.every((row) => row.passed));
  assert.ok(Math.abs(rows[0].deltaPP + 0.5) < 0.0001);
});

test('a larger decline fails and reports relative regression', () => {
  const rows = compareCoverage(summary(79), summary(80), 0.5);
  assert.ok(rows.every((row) => !row.passed));
  assert.ok(Math.abs(rows[0].relativeRegressionPct - 1.25) < 0.0001);
});

test('higher coverage passes', () => {
  const rows = compareCoverage(summary(85), summary(80));
  assert.ok(rows.every((row) => row.passed));
  assert.ok(rows.every((row) => row.deltaPP === 5));
});

test('baseline can be omitted on main without skipping coverage validation', () => {
  const rows = compareCoverage(summary(25), null);
  assert.ok(rows.every((row) => row.passed && row.baseline === null));
});

test('zero-covered files still have valid zero coverage', () => {
  const rows = compareCoverage(summary(0), summary(0));
  assert.ok(rows.every((row) => row.passed));
});

test('invalid or missing counts fail loudly', () => {
  assert.throws(() => coveragePercentage({ covered: 0, total: 0 }), /empty/);
  assert.throws(() => compareCoverage({ total: {} }, summary(10)), /empty/);
  assert.throws(() => compareCoverage(summary(0), summary(0), -1), /non-negative/);
});

test('report interpolates actual percentages rather than raw template syntax', () => {
  const report = renderSummary(compareCoverage(summary(75), summary(80)), 0.5, 'abc123');
  assert.match(report, /75\.00%/);
  assert.match(report, /80\.00%/);
  assert.match(report, /-5\.00/);
  assert.match(report, /FAIL/);
  assert.doesNotMatch(report, /\$\{/);
});
