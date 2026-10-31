import nodemailer from 'nodemailer';

// No scheduler, no CLI and no email on import. The future trusted operator
// invokes this only after the first accepted release and separate activation.
// Internal stage identifiers must never appear as untranslated labels in operator email.
const FAILURE_STAGE_LABELS = new Map([
  ['registry', 'реестр банков'],
  ['validation', 'проверка данных'],
  ['ci', 'проверки CI'],
  ['merge', 'слияние изменений'],
  ['deployment', 'публикация сайта'],
  ['rollback', 'откат обновления'],
]);
const CI_LOG_LINK = /^https:\/\/github\.com\/kurt525\/billok\/actions\/runs\/[1-9][0-9]*(?:\/attempts\/[1-9][0-9]*)?$/;

function cleanLine(text, maxLength = 240) {
  if (typeof text !== 'string') return null;
  const value = text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > 0 ? value.slice(0, maxLength) : null;
}

function approvedForAlerts(publicationState) {
  return (
    publicationState?.firstReleasePublishedAndAccepted === true &&
    publicationState?.catalogAutomationExplicitlyEnabled === true
  );
}

export function prepareSbpCatalogFailureEmail({ publicationState, stage, message, logUrl } = {}) {
  if (!approvedForAlerts(publicationState)) {
    return { allowed: false, reason: 'Bank catalog automation not enabled after accepted first release' };
  }
  if (!FAILURE_STAGE_LABELS.has(stage)) {
    return { allowed: false, reason: 'Not an allowed bank catalog failure stage' };
  }
  if (typeof logUrl !== 'string' || !CI_LOG_LINK.test(logUrl)) {
    return { allowed: false, reason: 'Trusted GitHub CI log link is required' };
  }
  const description = cleanLine(message);
  if (!description) {
    return { allowed: false, reason: 'Nonempty failure description is required' };
  }
  const title = '[BillOK] Ошибка обновления банков СБП';
  return {
    allowed: true,
    subject: title,
    text: [
      'Автоматическое обновление каталога банков СБП не завершено.',
      'Этап: ' + FAILURE_STAGE_LABELS.get(stage),
      'Причина: ' + description,
      'Журнал: ' + logUrl,
      'Требуется проверка оператором. Успешные обновления не создают писем.',
    ].join('\n'),
  };
}

export async function sendSbpCatalogFailureEmail({
  publicationState,
  stage,
  message,
  logUrl,
  env = process.env,
  createTransport = (config) => nodemailer.createTransport(config),
} = {}) {
  const prepared = prepareSbpCatalogFailureEmail({ publicationState, stage, message, logUrl });
  if (!prepared.allowed) return { sent: false, reason: prepared.reason };
  // SMTP secrets come ONLY from the VPS environment, never from a GitHub PR,
  // registry response, URL or repository source.
  const host = env?.BILLOK_SBP_ALERT_SMTP_HOST;
  const portText = env?.BILLOK_SBP_ALERT_SMTP_PORT;
  const port = Number(portText);
  const user = env?.BILLOK_SBP_ALERT_SMTP_USER;
  const pass = env?.BILLOK_SBP_ALERT_SMTP_PASSWORD;
  const from = env?.BILLOK_SBP_ALERT_FROM;
  const to = env?.BILLOK_SBP_ALERT_TO;
  if (
    typeof host !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    ![user, pass, from, to].every((value) => typeof value === 'string' && value.length > 0) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)
  ) {
    return { sent: false, reason: 'Trusted VPS SMTP configuration is incomplete' };
  }
  const transport = createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user, pass },
  });
  const info = await transport.sendMail({ from, to, subject: prepared.subject, text: prepared.text });
  // A resolved SMTP request is not proof the intended recipient was accepted.
  // Fail closed on missing/ambiguous acceptance rather than falsely reporting
  // that an operator received an incident notification.
  const recipient = to.toLowerCase();
  const accepted = info?.accepted?.some(
    (address) => typeof address === 'string' && address.toLowerCase() === recipient,
  );
  const rejected = info?.rejected?.some(
    (address) => typeof address === 'string' && address.toLowerCase() === recipient,
  );
  if (!accepted || rejected) {
    return { sent: false, reason: 'SMTP did not accept intended failure alert recipient' };
  }
  return { sent: true };
}
