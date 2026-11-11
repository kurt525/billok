// Parse only loopback QA links from Nodemailer's MIME message.
// Registration confirmation uses Base64 text and quoted-printable HTML.
const qaLink = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/verify-email\?token=[A-Za-z0-9_-]{43}/g;

export function linksInMessage(raw) {
  const alternatives = [
    raw
      .replace(/=\r?\n/g, '')
      .replace(/=3D/gi, '=')
      .replace(/&amp;/gi, '&'),
  ];

  for (const match of raw.matchAll(
    /Content-Transfer-Encoding:[ \t]*base64[ \t]*\r?\n\r?\n((?:[A-Za-z0-9+/=]+\r?\n)+)/gi,
  )) {
    const encoded = match[1].replace(/\s+/g, '');
    if (encoded.length <= 120_000) {
      alternatives.push(Buffer.from(encoded, 'base64').toString('utf8'));
    }
  }

  return [...new Set(alternatives.flatMap((part) => part.match(qaLink) ?? []))];
}
