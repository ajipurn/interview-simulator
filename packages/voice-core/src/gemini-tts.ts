import { sseData } from "./sse.js";
import type { AudioChunk, TtsProvider } from "./types.js";

/** Extract base64 PCM from one Gemini TTS streamGenerateContent SSE event. */
export function extractGeminiAudio(payload: string): string {
  const event = JSON.parse(payload) as {
    candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[];
    error?: { message: string };
  };
  if (event.error) throw new Error(`Gemini TTS stream error: ${event.error.message}`);
  return (event.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.inlineData?.data ?? "")
    .join("");
}

/**
 * Gemini TTS (generativelanguage API) — reuses the same API key as the Gemini
 * LLM adapter. Output: 24kHz 16-bit mono PCM. Indonesian is supported by the
 * prebuilt voices; pick via GEMINI_TTS_VOICE.
 */
export class GeminiTtsProvider implements TtsProvider {
  readonly sampleRate = 24000;

  constructor(
    private apiKey: string,
    private voice: string = process.env.GEMINI_TTS_VOICE ?? "Kore",
    private model: string = process.env.GEMINI_TTS_MODEL ?? "gemini-2.5-flash-preview-tts",
  ) {}

  async *synthesize(text: string, opts?: { signal?: AbortSignal }): AsyncIterable<AudioChunk> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "x-goog-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
        },
      }),
      signal: opts?.signal ?? null,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Gemini TTS API ${res.status}: ${await res.text()}`);
    }

    // base64 chunks can split mid-sample after decode; carry the odd byte
    let carry: Uint8Array | null = null;
    for await (const payload of sseData(res.body)) {
      if (opts?.signal?.aborted) return;
      const b64 = extractGeminiAudio(payload);
      if (!b64) continue;
      let bytes: Uint8Array = Buffer.from(b64, "base64");
      if (carry) {
        const merged = new Uint8Array(carry.length + bytes.length);
        merged.set(carry);
        merged.set(bytes, carry.length);
        bytes = merged;
        carry = null;
      }
      const usable = bytes.length - (bytes.length % 2);
      if (bytes.length % 2 !== 0) carry = bytes.slice(usable);
      if (usable === 0) continue;
      const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + usable));
      yield { pcm, sampleRate: this.sampleRate };
    }
  }
}
