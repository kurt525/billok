import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Issue #1, 4.7: the SBP beneficiary UI is a phone/bank contact display,
 * not a payment service. This guard is intentionally scoped to the SBP
 * components; receipt invitation links and unrelated legacy modules are
 * separate features and must not be mistaken for an SBP payment URL.
 */
const sbpUiFiles = [
  '../../src/components/guest-payer-sbp-form.tsx',
  '../../src/components/guest-sbp-reimbursement-details.tsx',
  '../../src/components/sbp-bank-logo.tsx',
  '../../src/lib/sbp-banks.ts',
];

const forbidden = [
  ['NSPK payment URL', /(?:qr\.nspk\.ru|sbp\.nspk\.ru\/pay)/i],
  ['payment protocol/deep link', /(?:\bpayto:|\bsbp:|bank100000|intent:\/\/)/i],
  ['payment QR generator', /\b(?:QRCodeSVG|QRCodeCanvas|QRCode|qrcode|qrCode)\b/],
  ['bank-app navigation', /\b(?:window\.open|window\.location|location\.assign|location\.replace)\b/],
  ['external payment anchor', /\bhref\s*=/i],
  [
    'payment URL import',
    /(?:import\s+.*(?:pay.?url|payment.?link|deep.?link)|from\s+['"][^'"]*(?:qr.?code|qrcode)[^'"]*['"])/i,
  ],
];

function verifyNoSbpPaymentLink(source) {
  const violation = forbidden.find(([, pattern]) => pattern.test(source));
  return violation ? violation[0] : null;
}

describe('BillOK 4.7: SBP is manual phone/bank transfer, never a payment link or QR', () => {
  it('keeps the actual SBP payer and beneficiary components free of payment links', () => {
    for (const file of sbpUiFiles) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.equal(verifyNoSbpPaymentLink(source), null, file);
    }
  });

  it('rejects attempts to introduce QR generation, payment links or bank navigation', () => {
    for (const attempt of [
      'const QR = QRCodeSVG;',
      'const x = "https://qr.nspk.ru/pay/abc";',
      'const x = "sbp://transfer?phone=79991234567";',
      'const x = "payto://sbp/transfer";',
      'window.location.href = someBankUrl;',
      'window.open(paymentUrl);',
      '<a href={paymentUrl}>Оплатить</a>',
      "import QRCode from 'qrcode';",
    ]) {
      assert.ok(verifyNoSbpPaymentLink(attempt), attempt);
    }
  });

  it('does not classify ordinary bank-selection and clipboard actions as payment initiation', () => {
    const expected = [
      'const selected = SBP_BANKS.find((bank) => bank.id === bankId);',
      'await copyToClipboard(contact.phone);',
      '<SbpBankLogo bank={selected} unavailableLabel={label} />',
      'const phone = normalizeSbpPhone(value);',
    ];
    for (const source of expected) assert.equal(verifyNoSbpPaymentLink(source), null, source);
  });
});
