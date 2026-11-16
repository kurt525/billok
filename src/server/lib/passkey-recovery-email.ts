import type { SMTPTransportOptions } from 'nodemailer';
import { sendBillokTransactionalEmail } from './transactional-email';

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
      '<p>Если кнопка недоступна, скопируйте адрес ссылки в браузер:</p>',
      '<p style="overflow-wrap:anywhere"><a href="' + safeUrl + '">' + safeUrl + '</a></p>',
      '<p>Ссылка действует 30 минут и используется один раз.</p>',
      '<p>Ссылка не выполняет вход. После регистрации ключа войдите с новым Passkey.</p>',
      '<p>Если вы не запрашивали восстановление, проигнорируйте письмо.</p>',
      '</div>',
    ].join(''),
  };
}

/** No recovery URL or auth token is ever included in this separate alert. */
export function russianPasskeyRecoveryCompletedEmail() {
  return {
    subject: 'BillOK — восстановление Passkey владельца завершено',
    text: [
      'Для учётной записи владельца BillOK зарегистрирован новый Passkey.',
      'Все ранее действовавшие Passkey и сеансы были отозваны.',
      'Ссылка восстановления не выполняла вход. Для доступа требуется обычная авторизация Passkey.',
      'Если вы не выполняли восстановление, проверьте безопасность своей почты и немедленно обратитесь к администратору сервера.',
    ].join('\n'),
    html: [
      '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">',
      '<h1>Восстановление Passkey владельца завершено</h1>',
      '<p>Зарегистрирован новый Passkey, все прежние ключи и сеансы отозваны.</p>',
      '<p>Для входа требуется подтверждение новым Passkey.</p>',
      '<p>Если вы не выполняли восстановление, проверьте безопасность электронной почты и обратитесь к администратору сервера.</p>',
      '</div>',
    ].join(''),
  };
}

export async function sendRussianPasskeyRecoveryCompletedEmail(input: {
  to: string;
  from: string;
  server: SMTPTransportOptions;
}): Promise<void> {
  await sendBillokTransactionalEmail({
    from: input.from,
    to: input.to,
    server: input.server,
    message: russianPasskeyRecoveryCompletedEmail(),
    errorMessage: 'Не удалось отправить уведомление о восстановлении Passkey',
  });
}

export async function sendRussianPasskeyRecoveryEmail(input: {
  to: string;
  url: string;
  from: string;
  server: SMTPTransportOptions;
}): Promise<void> {
  await sendBillokTransactionalEmail({
    from: input.from,
    to: input.to,
    server: input.server,
    message: russianPasskeyRecoveryEmail(input.url),
    errorMessage: 'Не удалось отправить письмо восстановления',
  });
}
