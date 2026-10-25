import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(resolve(process.cwd(), name), 'utf8');

describe('BillOK manual-only customer journey', () => {
  it('creates anonymous RUB receipts without image, OCR, or remote AI', () => {
    const guest = read('src/app/[locale]/split/page.tsx');
    expect(guest).toContain("useState<Step>('people')");
    expect(guest).toContain("currency: 'RUB'");
    expect(guest).toContain('manual-receipt-name');
    expect(guest).toContain('parseReceiptQuantity(newItem.quantity)');
    expect(guest).toContain('createSplit.mutateAsync');
    expect(guest).not.toContain('processReceipt');
    expect(guest).not.toContain('guest.getUploadStatus');
    expect(guest).not.toContain('/api/upload');
    expect(guest).not.toContain('receiptId:');
    expect(guest).not.toContain('showRescan');
    expect(guest).not.toContain('type="file"');
  });

  it('does not offer AI provider administration or scanning as a new group expense', () => {
    const admin = read('src/app/[locale]/(app)/admin/page.tsx');
    const group = read('src/app/[locale]/(app)/groups/[groupId]/page.tsx');
    for (const component of [
      'AIStatsSection',
      'AIProviderTestSection',
      'MeridianAuthSection',
      'OpenAICodexAuthSection',
      'GuestUploadSettingsSection',
    ]) {
      expect(admin).not.toContain(component);
    }
    expect(group).not.toContain('detail.scanReceipt');
    expect(group).not.toContain('<Camera');
    expect(group).toContain('/expenses/new');
    expect(read('src/app/[locale]/(app)/groups/new/page.tsx')).toContain("useState('RUB')");
    const legacy = read('src/app/[locale]/(app)/groups/[groupId]/scan/page.tsx');
    expect(legacy).toContain('router.replace(`/groups/${groupId}/expenses/new`)');
    expect(legacy).toContain('if (!resumeReceiptId) return;');
  });
});
