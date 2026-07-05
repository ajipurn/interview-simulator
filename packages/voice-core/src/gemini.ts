import { sseData } from "./sse.js";
import type { LlmMessage, LlmOptions, LlmProvider } from "./types.js";

/** Extract the text delta from one Gemini streamGenerateContent SSE event. */
export function extractGeminiDelta(payload: string): string {
  const event = JSON.parse(payload) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    error?: { message: string };
  };
  if (event.error) throw new Error(`Gemini stream error: ${event.error.message}`);
  return (event.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

/** Google Gemini (generativelanguage API) over fetch + SSE. */
export class GeminiLlmProvider implements LlmProvider {
  constructor(
    private apiKey: string,
    private model: string = process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
  ) {}

  async *stream(messages: LlmMessage[], opts?: LlmOptions): AsyncIterable<string> {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "x-goog-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        generationConfig: {
          temperature: opts?.temperature,
          maxOutputTokens: opts?.maxTokens ?? 1024,
          // voice latency: disable thinking where the model allows it
          ...(this.model.includes("2.5-flash") ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      }),
      signal: opts?.signal ?? null,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
    }
    for await (const payload of sseData(res.body)) {
      const delta = extractGeminiDelta(payload);
      if (delta) yield delta;
    }
  }

  async complete(messages: LlmMessage[], opts?: LlmOptions): Promise<string> {
    let out = "";
    for await (const d of this.stream(messages, opts)) out += d;
    return out;
  }
}
