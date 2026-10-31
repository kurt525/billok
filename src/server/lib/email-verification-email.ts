/**
 * The message for registration email confirmation (not an Auth.js sign-in link).
 * Keep template generation independent of SMTP delivery or database writes.
 */
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

export function russianRegistrationVerificationEmail(url: string) {
  const parsed = new URL(url);
  const isLocalHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (!(parsed.protocol === 'https:' || isLocalHttp) || parsed.username || parsed.password) {
    throw new Error('Недопустимая ссылка подтверждения электронной почты');
  }
  const safeUrl = escapeHtml(url);

  return {
    subject: 'Подтвердите электронную почту для BillOK',
    text: [
      'Здравствуйте!',
      '',
      'Для завершения регистрации в BillOK подтвердите адрес электронной почты:',
      url,
      '',
      'Ссылка действует 30 минут и может быть использована только один раз.',
      'Если вы не регистрировались в BillOK, проигнорируйте это письмо.',
    ].join('\n'),
    html: [
      '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#222">',
      '<h1 style="font-size:22px">Подтверждение почты в BillOK</h1>',
      '<p>Для завершения регистрации подтвердите адрес электронной почты:</p>',
      '<p><a href="' + safeUrl + '" style="display:inline-block;padding:12px 20px;',
      'background:#166534;color:#fff;border-radius:8px;text-decoration:none">Подтвердить почту</a></p>',
      '<p>Или откройте ссылку в браузере:</p>',
      '<p style="overflow-wrap:anywhere"><a href="' + safeUrl + '">' + safeUrl + '</a></p>',
      '<p>Ссылка действует <strong>30 минут</strong> и может быть использована только один раз.</p>',
      '<p style="color:#666">Если вы не регистрировались в BillOK, проигнорируйте это письмо.</p>',
      '</div>',
    ].join('\n'),
  };
}
