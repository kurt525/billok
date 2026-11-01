import nodemailer from 'nodemailer';
import type { SMTPTransportOptions } from 'nodemailer';

function escapeHtml(s: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => entities[c]!);
}
export function russianPasswordResetEmail(url: string) {
  const parsed = new URL(url);
  const local = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (
    !(parsed.protocol === 'https:' || local) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/reset-password'
  ) {
    throw new Error('Недопустимая ссылка восстановления пароля');
  }
  return {
    subject: 'Восстановление пароля BillOK',
    text: [
      'Здравствуйте!',
      '',
      'Для установки нового пароля BillOK откройте ссылку:',
      url,
      '',
      'Ссылка действует 30 минут и используется один раз.',
      'Если вы не запрашивали восстановление, проигнорируйте письмо.',
    ].join('\n'),
    html: [
      '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">',
      '<h1>Восстановление пароля BillOK</h1>',
      '<p>Для установки нового пароля откройте ссылку:</p>',
      '<p><a href="' + escapeHtml(url) + '">Установить новый пароль</a></p>',
      '<p>Ссылка действует 30 минут и используется один раз.</p>',
      '<p>Если вы не запрашивали восстановление, проигнорируйте письмо.</p>',
      '</div>',
    ].join(''),
  };
}
export async function sendRussianPasswordResetEmail(input: {
  to: string;
  url: string;
  from: string;
  server: SMTPTransportOptions;
}): Promise<void> {
  const transport = nodemailer.createTransport(input.server);
  const result = await transport.sendMail({ from: input.from, to: input.to, ...russianPasswordResetEmail(input.url) });
  if (result.rejected?.length || result.pending?.length || (result.accepted && !result.accepted.includes(input.to))) {
    throw new Error('Письмо восстановления не принято сервером');
  }
}
