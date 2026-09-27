import { writeFileSync } from "node:fs";
import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";

export interface MailMessage { from: string; to: string[]; subject: string; text: string; html: string }
export interface Mailer { send(msg: MailMessage): Promise<{ messageId: string }> }

type TransportFactory = (opts: SMTPTransport.Options) => Transporter;

export function createSmtpMailer(env: NodeJS.ProcessEnv, transportFactory?: TransportFactory): Mailer {
  const user = env.SMTP_USER;
  const pass = env.SMTP_APP_PASSWORD;
  if (!user) throw new Error("missing SMTP_USER");
  if (!pass) throw new Error("missing SMTP_APP_PASSWORD");
  const factory: TransportFactory = transportFactory ?? ((opts) => nodemailer.createTransport(opts));
  const transport = factory({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
  return {
    async send(msg) {
      const info = await transport.sendMail({
        from: msg.from, to: msg.to.join(", "), subject: msg.subject, text: msg.text, html: msg.html,
      });
      return { messageId: String(info.messageId) };
    },
  };
}

export function createFileMailer(outPath: string): Mailer {
  return {
    async send(msg) {
      writeFileSync(outPath, JSON.stringify(msg, null, 2) + "\n");
      return { messageId: `file:${outPath}` };
    },
  };
}
