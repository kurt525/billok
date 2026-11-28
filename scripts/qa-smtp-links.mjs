// Parse only loopback QA links from Nodemailer's MIME message.
// Registration confirmation uses Base64 text and quoted-printable HTML.
const qaLink =
  /https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/(?:(?:verify-email|recover-passkey)\?token=|settings#email-change=)[A-Za-z0-9_-]{43}/g;

export function linksInMessage(raw) {
  const alternatives = [
    raw
      .replace(/=\r?\n/g, '')
      .replace(/=3D/gi, '=')
      .replace(/&amp;/gi, '&'),
  ];

  // A single-part MIME message can have additional headers after its
  // transfer-encoding header. SMTP may also omit the final line ending.
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^Content-Transfer-Encoding:[ \t]*base64[ \t]*$/i.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && lines[j] !== '' && !lines[j].startsWith('--')) j++;
    if (lines[j] !== '') continue;
    let encoded = '';
    for (j++; j < lines.length && /^[A-Za-z0-9+/=]+$/.test(lines[j]); j++) {
      encoded += lines[j];
      if (encoded.length > 120_000) break;
    }
    if (encoded.length && encoded.length <= 120_000) {
      alternatives.push(Buffer.from(encoded, 'base64').toString('utf8'));
    }
  }

  return [...new Set(alternatives.flatMap((part) => part.match(qaLink) ?? []))];
}
