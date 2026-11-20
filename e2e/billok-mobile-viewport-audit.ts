import { expect, type Locator, type Page } from '@playwright/test';

// Diagnostics are scoped to visible browser geometry, never receipt or account logic.
export async function auditMobileViewport(page: Page, width: number, context: string) {
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  const evidence = await page.evaluate((requestedWidth) => {
    const doc = document.documentElement;
    const overflowing = window.innerWidth !== requestedWidth || doc.scrollWidth > requestedWidth + 1;
    const offenders = overflowing
      ? [...document.querySelectorAll<HTMLElement>('body *')]
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
              tag: element.tagName,
              testId: element.dataset.testid ?? null,
              id: element.id || null,
              className: typeof element.className === 'string' ? element.className.slice(0, 100) : '',
              left: Math.round(rect.left * 10) / 10,
              right: Math.round(rect.right * 10) / 10,
              width: Math.round(rect.width * 10) / 10,
              scrollWidth: element.scrollWidth,
              clientWidth: element.clientWidth,
              overflowX: style.overflowX,
              whiteSpace: style.whiteSpace,
              label: (element.textContent ?? '').trim().slice(0, 45),
            };
          })
          .filter((element) => element.width > 0 && (element.left < -2 || element.right > requestedWidth + 2))
          .sort((a, b) => b.right - a.right)
          .slice(0, 15)
      : [];
    return {
      requestedWidth,
      innerWidth: window.innerWidth,
      docScrollWidth: doc.scrollWidth,
      visualViewportWidth: window.visualViewport?.width ?? null,
      height: window.innerHeight,
      fontSize: getComputedStyle(doc).fontSize,
      offenders,
    };
  }, width);
  const detail = context + ' at ' + width + ' CSS px: ' + JSON.stringify(evidence);
  expect(evidence.innerWidth, 'Expanded viewport ' + detail).toBe(width);
  expect(evidence.docScrollWidth, 'Horizontal document overflow ' + detail).toBeLessThanOrEqual(width + 1);
  expect(parseFloat(evidence.fontSize), 'Root font size ' + detail).toBe(20);
  expect(evidence.height, 'Keyboard-sized viewport ' + detail).toBe(300);
}

export async function auditMobileTarget(target: Locator, width: number, label: string) {
  await expect(target).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  const measurements = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const hitX = rect.left + rect.width / 2;
    const hitY = rect.top + rect.height / 2;
    const topElement = document.elementFromPoint(hitX, hitY);
    return {
      x: rect.left,
      right: rect.right,
      y: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      fontSize: style.fontSize,
      visibleTarget: topElement === element || element.contains(topElement),
      coveredBy: topElement?.getAttribute('data-testid') ?? topElement?.tagName ?? 'none',
    };
  });
  const detail = label + ' at ' + width + ' CSS px: ' + JSON.stringify(measurements);
  expect(measurements.x, 'Control left ' + detail).toBeGreaterThanOrEqual(-1);
  expect(measurements.right, 'Control right ' + detail).toBeLessThanOrEqual(width + 1);
  expect(measurements.y, 'Control top ' + detail).toBeGreaterThanOrEqual(-1);
  expect(measurements.bottom, 'Control bottom ' + detail).toBeLessThanOrEqual(301);
  expect(measurements.height, 'Touch target height ' + detail).toBeGreaterThanOrEqual(44);
  expect(measurements.visibleTarget, 'Control covered by another element ' + detail).toBe(true);
}
