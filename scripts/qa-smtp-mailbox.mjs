// Disposable, loopback-only SMTP STARTTLS mailbox for isolated CI acceptance.
// Do not deploy or enable this service in production.
import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';

const smtpPort = Number(process.env.BILLOK_QA_SMTP_PORT);
const httpPort = Number(process.env.BILLOK_QA_MAIL_HTTP_PORT);
if (
  !Number.isInteger(smtpPort) ||
  !Number.isInteger(httpPort) ||
  !process.env.BILLOK_QA_TLS_KEY ||
  !process.env.BILLOK_QA_TLS_CERT
) {
  throw new Error('QA SMTP requires two ports and an ephemeral TLS key/certificate');
}
const secureContext = tls.createSecureContext({
  key: readFileSync(process.env.BILLOK_QA_TLS_KEY),
  cert: readFileSync(process.env.BILLOK_QA_TLS_CERT),
});
const messages = [];
const maxMessages = 60;
const maxMessageBytes = 120_000;

function linksInMessage(raw) {
  // Undo quoted-printable soft-wrap and encoding; never log raw tokens.
  const unfolded = raw
    .replace(/=\r?\n/g, '')
    .replace(/=3D/gi, '=')
    .replace(/&amp;/gi, '&');
  const matches = unfolded.match(
    /https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/(?:verify-email|reset-password)\?token=[A-Za-z0-9_-]{43}/g,
  );
  return [...new Set(matches ?? [])];
}

const smtp = net.createServer((initialSocket) => {
  const state = { secure: false, loggedIn: false, data: false, bytes: 0, lines: [], recipient: '', authStage: '' };

  function attach(socket) {
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > maxMessageBytes + 8192) {
        socket.destroy();
        return;
      }
      let split;
      while ((split = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, split).replace(/\r$/, '');
        buffer = buffer.slice(split + 1);
        command(line, socket);
        if (socket.destroyed) return;
      }
    });
  }

  function command(line, socket) {
    const reply = (value) => socket.write(value + '\r\n');
    if (state.data) {
      if (line === '.') {
        if (messages.length >= maxMessages) messages.shift();
        messages.push({ to: state.recipient, links: linksInMessage(state.lines.join('\r\n')) });
        state.data = false;
        state.lines = [];
        state.bytes = 0;
        reply('250 Message accepted for QA');
      } else {
        state.bytes += line.length;
        if (state.bytes > maxMessageBytes) socket.destroy();
        else state.lines.push(line.startsWith('..') ? line.slice(1) : line);
      }
      return;
    }
    if (state.authStage) {
      if (state.authStage === 'username') {
        state.authStage = 'password';
        reply('334 UGFzc3dvcmQ6');
      } else {
        state.authStage = '';
        state.loggedIn = true;
        reply('235 2.7.0 QA authentication accepted');
      }
      return;
    }
    const verb = line.split(/\s+/, 1)[0]?.toUpperCase();
    switch (verb) {
      case 'EHLO':
        reply(
          [
            '250-qa-mail.local',
            ...(state.secure ? [] : ['250-STARTTLS']),
            '250-AUTH PLAIN LOGIN',
            '250 SIZE 120000',
          ].join('\r\n'),
        );
        break;
      case 'HELO':
        reply('250 qa-mail.local');
        break;
      case 'STARTTLS':
        if (state.secure) {
          reply('503 Already secured');
          break;
        }
        socket.write('220 2.0.0 Ready to start TLS\r\n', () => {
          socket.removeAllListeners('data');
          const encrypted = new tls.TLSSocket(socket, { isServer: true, secureContext });
          state.secure = true;
          attach(encrypted);
        });
        break;
      case 'AUTH':
        if (!state.secure) {
          reply('538 Encryption required');
          break;
        }
        if (/^AUTH LOGIN(?:\s*)$/i.test(line)) {
          state.authStage = 'username';
          reply('334 VXNlcm5hbWU6');
        } else {
          state.loggedIn = true;
          reply('235 2.7.0 QA authentication accepted');
        }
        break;
      case 'MAIL':
        reply(state.secure && state.loggedIn ? '250 OK' : '530 Authentication required');
        break;
      case 'RCPT': {
        if (!state.secure || !state.loggedIn) {
          reply('530 Authentication required');
          break;
        }
        const match = /^RCPT TO:\s*<([^>]+)>/i.exec(line);
        if (!match) {
          reply('501 Invalid recipient');
          break;
        }
        state.recipient = match[1].toLowerCase();
        reply('250 OK');
        break;
      }
      case 'DATA':
        if (!state.recipient || !state.loggedIn) {
          reply('503 Need recipient');
          break;
        }
        state.data = true;
        state.lines = [];
        state.bytes = 0;
        reply('354 End with <CRLF>.<CRLF>');
        break;
      case 'RSET':
        state.recipient = '';
        reply('250 Reset');
        break;
      case 'NOOP':
        reply('250 OK');
        break;
      case 'QUIT':
        reply('221 Goodbye');
        socket.end();
        break;
      default:
        reply('502 Command not implemented');
    }
  }

  attach(initialSocket);
  initialSocket.write('220 qa-mail.local ESMTP disposable test service\r\n');
});

const api = http.createServer((req, res) => {
  const address = new URL(req.url ?? '/', 'http://localhost');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && address.pathname === '/health') {
    res.end(JSON.stringify({ ready: true }));
  } else if (req.method === 'GET' && address.pathname === '/messages') {
    const to = (address.searchParams.get('to') ?? '').toLowerCase();
    res.end(JSON.stringify({ messages: messages.filter((m) => m.to === to) }));
  } else {
    res.writeHead(404);
    res.end('{}');
  }
});
smtp.listen(smtpPort, '127.0.0.1');
api.listen(httpPort, '127.0.0.1');
