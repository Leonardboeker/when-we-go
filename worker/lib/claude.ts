// worker/lib/claude.ts
// Phase 7 — generic structured-output client for Anthropic Claude's `tools`
// API. Forces JSON output that matches a caller-supplied JSON schema, so the
// caller can type the result without parsing prose.
//
// Why a generic wrapper: future phases (suggestions, summaries, …) will all
// want the same "force a typed JSON shape out of Claude" recipe; lifting it
// here keeps activity-provider-claude.ts small + reuse-friendly.
//
// Contract:
//   - POST https://api.anthropic.com/v1/messages
//   - Headers: x-api-key, anthropic-version, content-type
//   - Forces tool use via `tool_choice: { type: 'tool', name }`
//   - Returns the `input` of the first tool_use content block on success
//   - 30s timeout via AbortController
//   - NEVER throws — caller handles { ok:false, error } gracefully
//
// Caller passes its own JSONSchema via `tool.input_schema`. Anthropic
// validates the output server-side, so when ok:true the data already conforms.
// We still treat the response defensively (return parse_error on shape drift).

export interface ClaudeToolDef {
  /** Tool name — referenced by tool_choice. Must match input_schema's purpose. */
  name: string;
  /** Short prose Anthropic shows to the model. */
  description: string;
  /** JSONSchema-ish object — Anthropic enforces this on the model's output. */
  input_schema: Record<string, unknown>;
}

export interface ClaudeStructuredArgs {
  /** Anthropic API key (sk-ant-…). */
  apiKey: string;
  /** Default haiku-latest for the cheap fast path. */
  model?: string;
  /** Max output tokens — keep modest to bound cost (default 2000). */
  maxTokens?: number;
  /** Optional system prompt — sets persona/guard-rails for the call. */
  systemPrompt?: string;
  /** Single user-turn message. We don't expose multi-turn here. */
  userMessage: string;
  /** The single tool definition the model is forced to call. */
  tool: ClaudeToolDef;
  /** Timeout for the fetch (ms). Default 30s. */
  timeoutMs?: number;
}

export type ClaudeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Make one structured-output call to Claude. Returns the typed `tool.input`
 * payload on success; on any failure (network, auth, malformed shape) returns
 * `{ ok: false, error }`. Never throws.
 *
 * The generic `T` is purely a TypeScript convenience — runtime trust comes
 * from Anthropic enforcing the supplied `input_schema`.
 */
export async function claudeStructured<T>(
  args: ClaudeStructuredArgs
): Promise<ClaudeResult<T>> {
  const {
    apiKey,
    // The 3-5-haiku-latest alias is deprecated by Anthropic; use the current
    // Haiku 4.5 GA model. Cheap + fast + same structured-output capability.
    model = 'claude-haiku-4-5',
    maxTokens = 2000,
    systemPrompt,
    userMessage,
    tool,
    timeoutMs = 30_000,
  } = args;

  if (!apiKey) return { ok: false, error: 'missing apiKey' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  type Body = {
    model: string;
    max_tokens: number;
    tools: ClaudeToolDef[];
    tool_choice: { type: 'tool'; name: string };
    messages: Array<{ role: 'user'; content: string }>;
    system?: string;
  };

  const body: Body = {
    model,
    max_tokens: maxTokens,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: userMessage }],
  };
  if (systemPrompt) body.system = systemPrompt;

  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('aborted') || msg.includes('AbortError')) {
      return { ok: false, error: `timeout after ${timeoutMs}ms` };
    }
    return { ok: false, error: `network: ${msg}` };
  }
  clearTimeout(timer);

  if (!res.ok) {
    let errText = '';
    try {
      errText = (await res.text()).slice(0, 300);
    } catch {
      /* swallow */
    }
    return { ok: false, error: `HTTP ${res.status}: ${errText}` };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    return {
      ok: false,
      error: `parse_error: response not valid JSON (${
        err instanceof Error ? err.message : String(err)
      })`,
    };
  }

  // Expected shape: { content: [{ type: 'tool_use', name, input: {...} }, ...] }
  const content = (json as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return { ok: false, error: 'parse_error: missing content array' };
  }
  const toolUse = (content as Array<Record<string, unknown>>).find(
    (b) => b.type === 'tool_use' && b.name === tool.name
  );
  if (!toolUse || !('input' in toolUse)) {
    return {
      ok: false,
      error: `parse_error: no tool_use block for "${tool.name}"`,
    };
  }
  return { ok: true, data: toolUse.input as T };
}
