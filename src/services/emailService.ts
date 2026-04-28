import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY && process.env.RESEND_API_KEY !== 're_placeholder'
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM = process.env.FROM_EMAIL ?? 'air.flow@gmx.de';

export interface SendEmailParams {
  to: string;
  subject: string;
  body: string;
}

function buildHtml(subject: string, body: string): string {
  const bodyLines = body.replace(/\n/g, '<br>');
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
        <tr><td style="background:#00ABA8;padding:24px 32px">
          <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700">airflow CareOS</h1>
          <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:13px">airflow Fachpflegedienst · Stephanstraße 7, 47799 Krefeld</p>
        </td></tr>
        <tr><td style="padding:32px">
          <h2 style="margin:0 0 16px;color:#1e293b;font-size:18px">${subject}</h2>
          <div style="color:#475569;font-size:14px;line-height:1.6">${bodyLines}</div>
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #e2e8f0;background:#f8fafc">
          <p style="margin:0;color:#94a3b8;font-size:12px">Automatische Nachricht von airflow CareOS. Bitte nicht antworten.<br>airflow Fachpflegedienst · MDK-zugelassen · Krefeld</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendEmail(params: SendEmailParams): Promise<{ success: boolean; error?: string }> {
  const { to, subject, body } = params;

  if (!resend) {
    console.log(`[emailService] RESEND not configured — would send to ${to}: ${subject}`);
    return { success: true };
  }

  try {
    const html = buildHtml(subject, body);
    const result = await resend.emails.send({ from: FROM, to, subject, html, text: body });

    if (result.error) {
      console.error('[emailService] Resend error:', result.error);
      return { success: false, error: result.error.message };
    }

    console.log(`[emailService] Sent "${subject}" to ${to}`);
    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[emailService] Exception:', msg);
    return { success: false, error: msg };
  }
}
