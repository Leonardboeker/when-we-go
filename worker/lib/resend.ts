// worker/lib/resend.ts
// Raw fetch to Resend Send-Email API. Adapted from pay-me-back-template's
// worker/lib/resend.ts and extended with `html` + `attachments` support for
// Phase 8's close-summary email (which embeds the .ics file as base64).
//
// The `from` address is read from WHENWEGO_RESEND_FROM. If unset, falls back to
// `onboarding@resend.dev` (Resend's sandbox sender — works without verifying a
// domain, but only delivers to verified recipients). For production, verify
// your own domain in the Resend dashboard and set WHENWEGO_RESEND_FROM to e.g.
// "when-we-go <hello@your-domain.com>".
//
// Fail-closed: any network/HTTP failure returns `{ ok: false, error }`. Never
// throws. 5s timeout via AbortController.
const RESEND_BASE = 'https://api.resend.com';
const TIMEOUT_MS = 5000;

export interface ResendAttachment {
  filename: string;
  content_base64: string;
  content_type: string;
}

export interface SendResendEmailParams {
  apiKey: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  attachments?: ResendAttachment[];
}

export interface SendResendEmailResult {
  ok: boolean;
  error?: string;
  status?: number; // HTTP status from Resend (for smoke-test assertions)
}

export async function sendResendEmail(
  params: SendResendEmailParams
): Promise<SendResendEmailResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const from = params.from ?? 'when-we-go <onboarding@resend.dev>';

  // Resend expects attachments as `{ filename, content, content_type }` where
  // `content` is base64-encoded bytes. Map our internal shape to that.
  const attachments = params.attachments?.map((a) => ({
    filename: a.filename,
    content: a.content_base64,
    content_type: a.content_type,
  }));

  try {
    const res = await fetch(`${RESEND_BASE}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [params.to],
        subject: params.subject,
        html: params.html,
        text: params.text,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      return {
        ok: false,
        status: res.status,
        error: `Resend ${res.status}: ${body.message ?? 'unknown'}`,
      };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Resend fetch error: ${msg}` };
  }
}
