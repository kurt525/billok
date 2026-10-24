import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const receiptViews = ['src/components/receipts/item-assignment.tsx', 'src/app/[locale]/split/page.tsx'];

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Mobile receipt item forms, guest and group', () => {
  for (const path of receiptViews) {
    it(path + ': stacks item inputs at phone width and keeps save/cancel reachable', () => {
      const source = read(path);
      expect(source).toContain('grid min-w-0 grid-cols-2 gap-2');
      expect(source).toContain('inputMode="numeric"');
      expect(source).toContain('inputMode="decimal"');
      expect(source).toContain('min-h-11');
      expect(source).toContain('parseReceiptQuantity(newItem.quantity)');
      expect(source).toContain('parseReceiptQuantity(editValues.quantity)');
      expect(source).not.toContain('parseInt(newItem.quantity) || 1');
      expect(source).not.toContain('parseInt(editValues.quantity)');
    });

    it(path + ': has touch-size item actions, participant chips and split controls', () => {
      const source = read(path);
      expect(source).toContain('flex size-11 shrink-0 items-center justify-center rounded-lg');
      expect(source).toContain('min-h-11 max-w-full items-center');
      expect(source).toContain('className="min-h-11"');
      expect(source).toContain('h-11 w-20 text-base');
      expect(source).toContain('flex flex-wrap items-center gap-2');
      expect(source).toContain('min-w-0 break-words font-medium');
    });
  }
});
