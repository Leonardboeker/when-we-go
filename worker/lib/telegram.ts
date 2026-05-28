// worker/lib/telegram.ts
// Raw fetch to Telegram Bot API sendMessage — plain text only (no markdown
// escaping, no parse_mode flag).  Mirrors pay-me-back's telegram.ts shape.
// Returns { ok, error? } — never throws.
const TELEGRAM_BASE = 'https://api.telegram.org';
const TIMEOUT_MS = 5000;

export async function sendTelegram(
  botToken: string,
  chatId: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${TELEGRAM_BASE}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        description?: string;
      };
      return {
        ok: false,
        error: `TG ${res.status}: ${body.description ?? 'unknown'}`,
      };
    }
    return { ok: true };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `TG fetch error: ${msg}` };
  }
}
