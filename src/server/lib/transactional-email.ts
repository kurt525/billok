import nodemailer from 'nodemailer';
import type { SMTPTransportOptions } from 'nodemailer';

/**
 * BillOK transactional mail only. SMTP is a delivery transport, NEVER an Auth.js
 * provider or sign-in mechanism. The caller supplies strictly validated
 * credentials from readRegistrationEmailConfig; this module issues no sessions.
 */
export type BillokTransactionalMessage = {
  subject: string;
  text: string;
  html?: string;
};

export async function sendBillokTransactionalEmail(input: {
  from: string;
  to: string;
  server: SMTPTransportOptions;
  message: BillokTransactionalMessage;
  errorMessage: string;
  timeouts?: { connectionTimeout: number; greetingTimeout: number; socketTimeout: number };
}): Promise<void> {
  const transport = nodemailer.createTransport(input.timeouts ? { ...input.server, ...input.timeouts } : input.server);
  try {
    const delivery = await transport.sendMail({
      from: input.from,
      to: input.to,
      ...input.message,
    });
    if (delivery.rejected?.length || delivery.pending?.length || !delivery.accepted?.includes(input.to)) {
      throw new Error(input.errorMessage);
    }
  } finally {
    // A short-lived per-message transport must release its connection.
    transport.close?.();
  }
}
