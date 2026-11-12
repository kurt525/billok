import nodemailer from 'nodemailer';
import type { SMTPTransportOptions } from 'nodemailer';

export function russianPasskeyRecoveryEmail(url: string) {
  const parsed = new URL(url);
  const local = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (
    !(parsed.protocol === 'https:' || local) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/recover-passkey'
  ) {
    throw new Error('Недопустимая ссылка восстановления');
  }
  const safeUrl = url.replace(
    /[&<>"']/gu,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]!,
  );
  return {
    subject: 'Восстановление Passkey для BillOK',
    text: [
      'Вы запросили замену ключа доступа BillOK.',
      'Для создания нового Passkey откройте ссылку:',
      url,
      '',
      'Ссылка действует 30 минут и используется один раз.',
      'Это не ссылка для входа: после создания ключа потребуется вход с Passkey.',
      'Если вы не запрашивали восстановление, проигнорируйте письмо.',
    ].join('\n'),
    html: [
      '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">',
      '<h1 style="font-size:22px">Восстановление ключа BillOK</h1>',
      '<p>Для создания нового Passkey откройте ссылку:</p>',
      '<p><a href="' + safeUrl + '">Создать новый ключ доступа</a></p>',
      '<p>Ссылка действует 30 минут и используется один раз.</p>',
      '<p>Ссылка не выполняет вход. После регистрации ключа войдите с новым Passkey.</p>',
      '<p>Если вы не запрашивали восстановление, проигнорируйте письмо.</p>',
      '</div>',
    ].join(''),
  };
}

export async function sendRussianPasskeyRecoveryEmail(input: {
  to: string;
  url: string;
  from: string;
  server: SMTPTransportOptions;
}): Promise<void> {
  const transport = nodemailer.createTransport(input.server);
  const delivery = await transport.sendMail({
    from: input.from,
    to: input.to,
    ...russianPasskeyRecoveryEmail(input.url),
  });
  if (
    delivery.rejected?.length ||
    delivery.pending?.length ||
    (delivery.accepted && !delivery.accepted.includes(input.to))
  ) {
    throw new Error('Не удалось отправить письмо восстановления');
  }
}
