import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatShareCount } from './ru-plurals';

describe('Russian labels in bill allocation forms', () => {
  it('uses Russian plural endings', () => {
    expect([0, 1, 2, 5, 11, 21, 22, 25].map(formatShareCount)).toEqual([
      '0 долей',
      '1 доля',
      '2 доли',
      '5 долей',
      '11 долей',
      '21 доля',
      '22 доли',
      '25 долей',
    ]);
  });

  it('keeps all four split methods free from upstream English status labels', () => {
    const methods = ['equal', 'exact', 'percentage', 'shares'];
    for (const method of methods) {
      const file = readFileSync(resolve(process.cwd(), `src/components/expenses/${method}-split.tsx`), 'utf8');
      expect(file).not.toMatch(/Fully allocated|over-allocated|per person|Unnamed|should be 100%|>shares<|Total:/);
      expect(file).toMatch(/Без имени|formatShareCount/);
    }
  });

  it('allows participant names to wrap on narrow phone screens', () => {
    for (const method of ['equal', 'exact', 'percentage', 'shares']) {
      const file = readFileSync(resolve(process.cwd(), `src/components/expenses/${method}-split.tsx`), 'utf8');
      expect(file).toContain('break-words');
    }
  });
});
