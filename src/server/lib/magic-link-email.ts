import nodemailer from 'nodemailer';
import type { SMTPTransportOptions } from 'nodemailer';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** Russian magic-link email, without Auth.js default English-facing text. */
export function russianSignInEmail(url: string) {
  const safeUrl = escapeHtml(url);
  return {
    subject: 'Ссылка для входа в BillOK',
    text: [
      'Здравствуйте!',
      '',
      'Чтобы войти в BillOK, откройте ссылку:',
      url,
      '',
      'Если вы не запрашивали вход, просто проигнорируйте это письмо.',
    ].join('\n'),
    html: [
      '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#222">',
      '<h1 style="font-size:22px">Вход в BillOK</h1>',
      '<p>Для входа нажмите кнопку:</p>',
      '<p><a href="' + safeUrl + '" style="display:inline-block;padding:12px 20px;',
      'background:#166534;color:#fff;border-radius:8px;text-decoration:none">Войти в BillOK</a></p>',
      '<p>Или скопируйте ссылку в браузер:</p>',
      '<p style="overflow-wrap:anywhere"><a href="' + safeUrl + '">' + safeUrl + '</a></p>',
      '<p style="color:#666">Если вы не запрашивали вход, просто проигнорируйте это письмо.</p>',
      '</div>',
    ].join('\n'),
  };
}

export async function sendRussianSignInEmail(input: {
  to: string;
  url: string;
  from: string;
  server: SMTPTransportOptions;
}) {
  const transporter = nodemailer.createTransport(input.server);
  const info = await transporter.sendMail({
    from: input.from,
    to: input.to,
    ...russianSignInEmail(input.url),
  });
  if (info.rejected?.length || info.pending?.length) {
    throw new Error('Не удалось отправить письмо для входа в BillOK');
  }
}
