import { describe, expect, it } from 'vitest';
import ru from '../../messages/ru/split.json';
import en from '../../messages/en/split.json';

const keys = [
  'markMyPayment',
  'paymentDeclared',
  'paymentAwaitingRecipient',
  'paymentVerifiedByRecipient',
  'paymentUnmarkAction',
  'payerPaymentDeclared',
  'payerPaymentGroupAwaiting',
  'payerPaymentDeclarationNotice',
  'payerPaymentDeclarationRevokedNotice',
  'paymentVerifiedNoticeDetailed',
  'paymentCancelNoticeDetailed',
  'payerPaymentVerifiedAudit',
] as const;

describe('Issue #1 5.19.1: gender-neutral payment action and event wording', () => {
  it('uses action-oriented Russian labels and never calls an unverified claim a received payment', () => {
    expect(ru.claim.markMyPayment).toBe('Сообщить об оплате');
    expect(ru.claim.paymentDeclared).toBe('Об оплате сообщено');
    expect(ru.claim.paymentAwaitingRecipient).toBe('Ожидается проверка поступления');
    expect(ru.claim.paymentUnmarkAction).toBe('Отозвать сообщение об оплате');
    expect(ru.claim.paymentVerifiedByRecipient).toBe('Поступление подтверждено');
    expect(ru.claim.payerPaymentDeclared).toBe('Об оплате сообщено — ожидается проверка');
    expect(ru.claim.payerPaymentGroupAwaiting).toBe('Сообщения об оплате — ожидают проверки');
    expect(ru.claim.payerPaymentReviewHint).toContain('не проверяет переводы автоматически');
  });

  it.each(['Анна', 'Борис', 'Илья', 'Полина'])(
    'formats payer/sender messages without gendered verbs for %s',
    (name) => {
      const values = { name, payer: name, amount: '4,59 ₽', receipt: 'Ужин', at: '10:00' };
      const format = (message: string) =>
        message.replace(/\{(name|payer|amount|receipt|at)\}/g, (_, key: keyof typeof values) => values[key]);
      for (const key of [
        'payerPaymentDeclarationNotice',
        'payerPaymentDeclarationRevokedNotice',
        'paymentVerifiedNoticeDetailed',
        'paymentCancelNoticeDetailed',
        'payerPaymentVerifiedAudit',
      ] as const) {
        const localized = format(ru.claim[key]);
        expect(localized).toContain(name);
        expect(localized).not.toMatch(/\b(?:подтвердил|отменил|сообщил)\b/iu);
        expect(localized).not.toMatch(/\{(?:name|payer|amount|receipt|at)\}/);
      }
    },
  );

  it('keeps corresponding English keys and the same interpolation parameters', () => {
    for (const key of keys) {
      expect(typeof en.claim[key]).toBe('string');
      const ruParams = [...ru.claim[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      const enParams = [...en.claim[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      expect(ruParams).toEqual(enParams);
    }
  });
});
