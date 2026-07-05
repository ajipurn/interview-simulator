import type { AudioChunk, TtsProvider } from "./types.js";

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Azure Speech TTS (REST, chunked streaming) → 24kHz 16-bit mono PCM.
 * Native Indonesian neural voices: id-ID-GadisNeural (female), id-ID-ArdiNeural (male).
 */
export class AzureTtsProvider implements TtsProvider {
  readonly sampleRate = 24000;

  constructor(
    private apiKey: string,
    private region: string = process.env.AZURE_SPEECH_REGION ?? "southeastasia",
    private voice: string = process.env.AZURE_SPEECH_VOICE ?? "id-ID-GadisNeural",
    // speaking rate, e.g. "+12%" — voices differ, tune by ear per voice
    private rate: string = process.env.AZURE_SPEECH_RATE ?? "0%",
  ) {}

  async *synthesize(text: string, opts?: { signal?: AbortSignal }): AsyncIterable<AudioChunk> {
    // "AI" otherwise read as English "ay"; alias forces Indonesian letter names
    const spoken = escapeXml(text).replace(/\bAI\b/g, "<sub alias='a-i'>AI</sub>");
    const ssml = `<speak version='1.0' xml:lang='id-ID'><voice name='${this.voice}'><lang xml:lang='id-ID'><prosody rate='${this.rate}'>${spoken}</prosody></lang></voice></speak>`;
    // a stalled TTS stream without a timeout freezes the reply loop mid-sentence
    const timeout = AbortSignal.timeout(30_000);
    const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const res = await fetch(
      `https://${this.region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": this.apiKey,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "raw-24khz-16bit-mono-pcm",
          "User-Agent": "selia-agent",
        },
        body: ssml,
        signal,
      },
    );
    if (!res.ok || !res.body) {
      // 400 comes with an empty body — name the usual suspects in the error
      throw new Error(
        `Azure TTS ${res.status} (voice=${this.voice} region=${this.region}): ${await res.text()}`,
      );
    }

    // raw PCM bytes can split mid-sample; carry the odd byte to the next chunk
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
