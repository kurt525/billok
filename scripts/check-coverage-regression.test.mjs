import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareCoverage,
  compareCommonSourceCoverage,
  coveragePercentage,
  METRICS,
  renderSummary,
} from './check-coverage-regression.mjs';

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

test('removed AI-only files do not distort common-source coverage', () => {
  const make = (covered, total) => Object.fromEntries(METRICS.map((name) => [name, { covered, total }]));
  const current = {
    total: make(50, 100),
    '/tmp/billok/src/core.ts': make(40, 50),
    '/tmp/billok/src/new-manual.ts': make(10, 50),
  };
  const baseline = {
    total: make(100, 200),
    '/tmp/main/src/core.ts': make(40, 50),
    '/tmp/main/src/server/ai/provider.ts': make(60, 150),
  };
  const result = compareCommonSourceCoverage(current, baseline, 0.5);
  assert.equal(result.sharedFiles, 1);
  assert.equal(result.currentOnlyFiles, 1);
  assert.equal(result.baselineOnlyFiles, 1);
  assert.ok(result.rows.every((row) => row.passed && row.deltaPP === 0));
});

test('the same 0.5 point threshold still rejects a common-source regression', () => {
  const make = (covered, total) => Object.fromEntries(METRICS.map((name) => [name, { covered, total }]));
  const current = { total: make(39, 100), '/tmp/billok/src/core.ts': make(39, 100) };
  const baseline = { total: make(40, 100), '/tmp/main/src/core.ts': make(40, 100) };
  const result = compareCommonSourceCoverage(current, baseline, 0.5);
  assert.ok(result.rows.every((row) => !row.passed && row.deltaPP === -1));
});

test('no common source files is a hard failure', () => {
  const metrics = Object.fromEntries(METRICS.map((name) => [name, { covered: 10, total: 20 }]));
  assert.throws(
    () =>
      compareCommonSourceCoverage(
        { total: metrics, '/tmp/billok/src/a.ts': metrics },
        { total: metrics, '/tmp/main/src/b.ts': metrics },
      ),
    /No shared source files/,
  );
});
