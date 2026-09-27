import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSmtpMailer, createFileMailer } from "../src/digest/mailer.js";

const msg = { from: "a@example.com", to: ["b@example.com", "c@example.com"], subject: "s", text: "t", html: "<p>t</p>" };

describe("createSmtpMailer", () => {
  it("requires both env vars", () => {
    expect(() => createSmtpMailer({})).toThrow(/missing SMTP_USER/);
    expect(() => createSmtpMailer({ SMTP_USER: "u" })).toThrow(/missing SMTP_APP_PASSWORD/);
  });

  it("builds a Gmail smtps transport and sends multipart", async () => {
    const captured: { opts?: unknown; mail?: unknown } = {};
    const factory = (opts: unknown) => {
      captured.opts = opts;
      return { sendMail: async (mail: unknown) => { captured.mail = mail; return { messageId: "<id@test>" }; } } as never;
    };
    const mailer = createSmtpMailer({ SMTP_USER: "u@gmail.com", SMTP_APP_PASSWORD: "pw" }, factory);
    const res = await mailer.send(msg);
    expect(res.messageId).toBe("<id@test>");
    expect(captured.opts).toMatchObject({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: "u@gmail.com", pass: "pw" } });
    expect(captured.mail).toMatchObject({ from: "a@example.com", to: "b@example.com, c@example.com", subject: "s", text: "t", html: "<p>t</p>" });
  });
});

describe("createFileMailer", () => {
  it("writes the message to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "propozaler-mail-"));
    const p = join(dir, "sent.json");
    const res = await createFileMailer(p).send(msg);
    expect(res.messageId).toMatch(/^file:/);
    expect(JSON.parse(readFileSync(p, "utf8")).subject).toBe("s");
  });
});
