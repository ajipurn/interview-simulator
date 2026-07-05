import type { AudioChunk, TtsProvider } from "./types.js";

/**
 * ElevenLabs streaming TTS → 24kHz 16-bit PCM. Uses the low-latency flash
 * model; Indonesian is covered by its multilingual support.
 */
export class ElevenLabsTtsProvider implements TtsProvider {
  readonly sampleRate = 24000;

  constructor(
    private apiKey: string,
    private voiceId: string,
    private modelId = "eleven_flash_v2_5",
  ) {}

  async *synthesize(text: string, opts?: { signal?: AbortSignal }): AsyncIterable<AudioChunk> {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream?output_format=pcm_24000`,
      {
        method: "POST",
        headers: { "xi-api-key": this.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ text, model_id: this.modelId }),
        signal: opts?.signal ?? null,
      },
    );
    if (!res.ok || !res.body) {
      throw new Error(`ElevenLabs API ${res.status}: ${await res.text()}`);
    }

    // Raw PCM bytes can split mid-sample; carry the odd byte to the next chunk.
    let carry: Uint8Array | null = null;
    for await (const raw of res.body) {
      if (opts?.signal?.aborted) return;
      let bytes = raw as Uint8Array;
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
