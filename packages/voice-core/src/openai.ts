import { sseData } from "./sse.js";
import type { LlmMessage, LlmOptions, LlmProvider } from "./types.js";

// A stalled connection with no timeout blocks the serialized engine queue
// forever — the interview goes permanently silent. Covers TTFB + full stream.
const LLM_TIMEOUT_MS = 30_000;
export function llmSignal(caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(LLM_TIMEOUT_MS);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

/** Extract the text delta from one OpenAI chat-completions stream event. */
export function extractOpenAiDelta(payload: string): string {
  const event = JSON.parse(payload) as {
    choices?: { delta?: { content?: string | null } }[];
    error?: { message: string };
  };
  if (event.error) throw new Error(`OpenAI stream error: ${event.error.message}`);
  return event.choices?.[0]?.delta?.content ?? "";
}

/**
 * Azure OpenAI (deployments endpoint) — same wire format as OpenAI chat
 * completions, different URL + api-key header. Billed against Azure credits.
 */
export class AzureOpenAiLlmProvider implements LlmProvider {
  constructor(
    private apiKey: string,
    private endpoint: string, // https://<resource>.openai.azure.com
    private deployment: string = process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-5-mini",
    private apiVersion: string = process.env.AZURE_OPENAI_API_VERSION ?? "2025-01-01-preview",
  ) {}

  async *stream(messages: LlmMessage[], opts?: LlmOptions): AsyncIterable<string> {
    const url = `${this.endpoint.replace(/\/$/, "")}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;
    // gpt-5 family rejects temperature/max_tokens; reasoning_effort minimal = no
    // thinking tokens (latency budget, same trick as Gemini thinkingBudget:0)
    const gpt5 = this.deployment.startsWith("gpt-5");
    const res = await fetch(url, {
      method: "POST",
      headers: { "api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        ...(gpt5
          ? { max_completion_tokens: opts?.maxTokens ?? 1024, reasoning_effort: "minimal" }
          : { max_tokens: opts?.maxTokens ?? 1024, temperature: opts?.temperature }),
        stream: true,
      }),
      signal: llmSignal(opts?.signal),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Azure OpenAI ${res.status}: ${await res.text()}`);
    }
    for await (const payload of sseData(res.body)) {
      const delta = extractOpenAiDelta(payload);
      if (delta) yield delta;
    }
  }

  async complete(messages: LlmMessage[], opts?: LlmOptions): Promise<string> {
    let out = "";
    for await (const d of this.stream(messages, opts)) out += d;
    return out;
  }
}

/** OpenAI Chat Completions over fetch + SSE. */
export class OpenAiLlmProvider implements LlmProvider {
  constructor(
    private apiKey: string,
    private model: string = process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
  ) {}

  async *stream(messages: LlmMessage[], opts?: LlmOptions): AsyncIterable<string> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        max_completion_tokens: opts?.maxTokens ?? 1024,
        temperature: opts?.temperature,
        stream: true,
      }),
      signal: llmSignal(opts?.signal),
    });
    if (!res.ok || !res.body) {
      throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
    }
    for await (const payload of sseData(res.body)) {
      const delta = extractOpenAiDelta(payload);
      if (delta) yield delta;
    }
  }

  async complete(messages: LlmMessage[], opts?: LlmOptions): Promise<string> {
    let out = "";
    for await (const d of this.stream(messages, opts)) out += d;
    return out;
  }
}
