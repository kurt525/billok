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
  const rows = compareCoverage(current, baseline, maxDropPP);
  const report = renderSummary(rows, maxDropPP, process.env.COVERAGE_BASE_SHA ?? '');
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
