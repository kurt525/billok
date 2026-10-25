// Compare coverage percentages on the same source scope for main and the PR branch.
// Usage: node scripts/check-coverage-regression.mjs <current-summary> [main-summary]
// Exit with failure when a metric loses more than MAX_COVERAGE_DROP_PP.
import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const METRICS = ['lines', 'statements', 'functions', 'branches'];

export function coveragePercentage(metric) {
  if (!metric || !Number.isInteger(metric.total) || metric.total <= 0) {
    throw new Error('Missing or empty coverage metric');
  }
  if (!Number.isInteger(metric.covered) || metric.covered < 0 || metric.covered > metric.total) {
    throw new Error('Invalid covered count');
  }
  return (100 * metric.covered) / metric.total;
}

export function compareCoverage(currentSummary, baselineSummary, maxDropPP = 0.5) {
  if (!Number.isFinite(maxDropPP) || maxDropPP < 0) {
    throw new Error('Max allowed coverage drop must be a non-negative number');
  }
  return METRICS.map((metric) => {
    const current = coveragePercentage(currentSummary.total?.[metric]);
    const baseline = baselineSummary ? coveragePercentage(baselineSummary.total?.[metric]) : null;
    const deltaPP = baseline === null ? null : current - baseline;
    const relativeRegressionPct = baseline && deltaPP !== null ? (100 * Math.max(0, -deltaPP)) / baseline : 0;
    return {
      metric,
      current,
      baseline,
      deltaPP,
      relativeRegressionPct,
      passed: deltaPP === null || deltaPP >= -maxDropPP - 1e-9,
    };
  });
}

function sourceSummaryMap(summary) {
  const files = new Map();
  for (const [key, metrics] of Object.entries(summary)) {
    if (key === 'total') continue;
    const normalized = key.replaceAll('\\\\', '/');
    const pos = normalized.lastIndexOf('/src/');
    const relative = pos >= 0 ? normalized.slice(pos + 1) : normalized.startsWith('src/') ? normalized : null;
    if (relative && files.has(relative)) throw new Error('Duplicate coverage file: ' + relative);
    if (relative) files.set(relative, metrics);
  }
  return files;
}

// Compare coverage on files that exist in both branches. Deleted upstream AI
// files and new BillOK-only files change repository-wide denominator; the same
// 0.5 point guard still applies to every source file shared across versions.
export function compareCommonSourceCoverage(currentSummary, baselineSummary, maxDropPP = 0.5) {
  const currentFiles = sourceSummaryMap(currentSummary);
  const baselineFiles = sourceSummaryMap(baselineSummary);
  const overlap = [...currentFiles.keys()].filter((name) => baselineFiles.has(name));
  if (overlap.length === 0) throw new Error('No shared source files in coverage reports');
  const aggregate = (files) => ({
    total: Object.fromEntries(
      METRICS.map((metric) => [
        metric,
        overlap.reduce(
          (acc, path) => {
            const row = files.get(path)?.[metric];
            if (
              !row ||
              !Number.isInteger(row.total) ||
              !Number.isInteger(row.covered) ||
              row.covered < 0 ||
              row.covered > row.total
            ) {
              throw new Error('Invalid coverage data for ' + path + ': ' + metric);
            }
            return { total: acc.total + row.total, covered: acc.covered + row.covered };
          },
          { total: 0, covered: 0 },
        ),
      ]),
    ),
  });
  return {
    rows: compareCoverage(aggregate(currentFiles), aggregate(baselineFiles), maxDropPP),
    sharedFiles: overlap.length,
    currentOnlyFiles: currentFiles.size - overlap.length,
    baselineOnlyFiles: baselineFiles.size - overlap.length,
  };
}

export function renderSummary(rows, maxDropPP, baselineLabel) {
  const lines = [
    '### Покрытие кода BillOK — проверка регрессии',
    '',
    baselineLabel
      ? `Сравнение с \`main\` (SHA: \`${baselineLabel}\`). Допустимое падение каждого показателя: **${maxDropPP.toFixed(2)} п.п.**`
      : 'Базовое покрытие ветки `main`.',
    '',
    '| Метрика | main | Текущая ветка | Изменение, п.п. | Относительная регрессия | Итог |',
    '|:--|--:|--:|--:|--:|:--|',
  ];
  for (const { metric, baseline, current, deltaPP, relativeRegressionPct, passed } of rows) {
    lines.push(
      `| ${metric} | ${baseline === null ? '—' : baseline.toFixed(2) + '%'} | ${current.toFixed(2)}% | ${deltaPP === null ? '—' : (deltaPP >= 0 ? '+' : '') + deltaPP.toFixed(2)} | ${baseline === null ? '—' : relativeRegressionPct.toFixed(2) + '%'} | ${passed ? 'PASS' : 'FAIL'} |`,
    );
  }
  lines.push('', rows.every((r) => r.passed) ? '**Результат: PASS**' : '**Результат: FAIL — регрессия покрытия**', '');
  return lines.join('\n');
}

async function main() {
  const [currentPath, baselinePath] = process.argv.slice(2);
  if (!currentPath) throw new Error('Usage: node scripts/check-coverage-regression.mjs current.json [main.json]');
  const current = JSON.parse(readFileSync(currentPath, 'utf8'));
  const baseline = baselinePath ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
  const maxDropPP = Number(process.env.MAX_COVERAGE_DROP_PP ?? '0.5');
  const comparison = baseline ? compareCommonSourceCoverage(current, baseline, maxDropPP) : null;
  const rows = comparison ? comparison.rows : compareCoverage(current, null, maxDropPP);
  const allMetrics = (summary) => METRICS.map((metric) => coveragePercentage(summary.total?.[metric]).toFixed(2) + '%');
  const scopeNote = comparison
    ? 'Shared files: ' +
      comparison.sharedFiles +
      '; BillOK-only: ' +
      comparison.currentOnlyFiles +
      '; main-only: ' +
      comparison.baselineOnlyFiles +
      '. Threshold applies to shared source files only.'
    : 'Main branch full coverage.';
  const allNote = baseline
    ? 'Full coverage (lines/statements/functions/branches): main ' +
      allMetrics(baseline).join(' / ') +
      '; BillOK ' +
      allMetrics(current).join(' / ') +
      '.'
    : 'Full coverage (lines/statements/functions/branches): ' + allMetrics(current).join(' / ') + '.';
  const report =
    renderSummary(rows, maxDropPP, process.env.COVERAGE_BASE_SHA ?? '') + '\n' + scopeNote + '\n' + allNote + '\n';
  process.stdout.write(report + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
  }
  if (rows.some((row) => !row.passed)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
