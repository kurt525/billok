import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = (p: string) => resolve(process.cwd(), p);
const read = (p: string) => readFileSync(root(p), 'utf8');

describe('BillOK does not ship OCR or AI service code', () => {
  test('provider registry, extraction pipeline and upload API are absent', () => {
    for (const path of [
      'src/server/ai',
      'src/server/lib/receipt-processor.ts',
      'src/server/lib/auth-health-poller.ts',
      'src/server/lib/meridian-login.ts',
      'src/server/lib/openai-codex-login.ts',
      'src/app/api/upload/route.ts',
    ]) {
      expect(existsSync(root(path)), path).toBe(false);
    }
  });

  test('OCR procedures are not present in application routers', () => {
    const guest = read('src/server/trpc/routers/guest.ts');
    const receipts = read('src/server/trpc/routers/receipts.ts');
    const admin = read('src/server/trpc/routers/admin.ts');
    for (const procedure of ['processReceipt', 'retryProcessing', 'getUploadStatus']) {
      expect(guest).not.toContain(procedure + ': publicProcedure');
      expect(guest).not.toContain(procedure + ': protectedProcedure');
      expect(receipts).not.toContain(procedure + ': publicProcedure');
      expect(receipts).not.toContain(procedure + ': protectedProcedure');
    }
    for (const procedure of [
      'testAIProvider',
      'getAIStats',
      'getMeridianAuthStatus',
      'startMeridianLogin',
      'getOpenAICodexAuthStatus',
      'startOpenAICodexLogin',
      'getGuestUploadsEnabled',
    ]) {
      expect(admin).not.toContain(procedure + ':');
    }
  });

  test('production dependencies, env and Compose contain no AI provider configuration', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    for (const dep of ['openai', '@anthropic-ai/sdk', '@rynfar/meridian']) {
      expect(pkg.dependencies).not.toHaveProperty(dep);
    }
    expect(pkg.scripts).not.toHaveProperty('test:ai');
    for (const file of ['.env.example', 'docker/docker-compose.yml', 'docker/entrypoint.sh']) {
      const config = read(file);
      for (const env of [
        'AI_PROVIDER_PRIORITY',
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'OLLAMA_BASE_URL',
        'MERIDIAN_PORT',
        'GUEST_AI_GLOBAL_LIMIT',
      ]) {
        expect(config, file).not.toContain(env);
      }
    }
  });

  test('manual receipt procedures remain in the router', () => {
    const receipts = read('src/server/trpc/routers/receipts.ts');
    expect(receipts).toContain('createManual:');
    expect(receipts).toContain('assignItemsAndCreateExpense:');
    expect(receipts).toContain('getReceiptItems:');
  });
});
