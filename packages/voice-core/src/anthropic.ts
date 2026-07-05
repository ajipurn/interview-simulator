import { sseData } from "./sse.js";
import type { LlmMessage, LlmOptions, LlmProvider } from "./types.js";

/** Extract the text delta from one Anthropic Messages stream event. */
export function extractAnthropicDelta(payload: string): string {
  const event = JSON.parse(payload) as {
    type: string;
    delta?: { type: string; text?: string };
    error?: { message: string };
  };
  if (event.type === "error") throw new Error(`Anthropic stream error: ${event.error?.message}`);
  if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
    return event.delta.text ?? "";
  }
  return "";
}

/**
 * Anthropic Messages API over fetch + SSE. No SDK dependency — the surface we
 * need (streaming text) is a single endpoint.
 */
export class AnthropicLlmProvider implements LlmProvider {
  constructor(
    private apiKey: string,
    private model: string = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
  ) {}

  async *stream(messages: LlmMessage[], opts?: LlmOptions): AsyncIterable<string> {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const rest = messages.filter((m) => m.role !== "system");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts?.maxTokens ?? 1024,
        temperature: opts?.temperature,
        system: system || undefined,
        messages: rest.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      }),
      signal: opts?.signal ?? null,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    }

    for await (const payload of sseData(res.body)) {
      const delta = extractAnthropicDelta(payload);
      if (delta) yield delta;
    }
  }

  async complete(messages: LlmMessage[], opts?: LlmOptions): Promise<string> {
    let out = "";
    for await (const d of this.stream(messages, opts)) out += d;
    return out;
  }
}
