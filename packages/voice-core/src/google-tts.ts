import { GoogleAuth } from "google-auth-library";
import type { AudioChunk, TtsProvider } from "./types.js";

const SYNTHESIZE_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";
const CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/**
 * Extract raw PCM samples from a LINEAR16 WAV container (Cloud TTS returns a
 * RIFF file, not bare PCM) by locating the "data" chunk.
 */
export function wavToPcm(buf: Buffer): Int16Array {
  let off = 12; // skip "RIFF"<size>"WAVE"
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      const start = off + 8;
      const end = Math.min(start + size, buf.length);
      const usable = end - start - ((end - start) % 2);
      return new Int16Array(
        buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + start + usable),
      );
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in WAV");
}

export interface GoogleTtsConfig {
  voice: string;
  languageCode: string;
  /** Gemini-TTS model id (e.g. gemini-2.5-flash-tts). Unset → Chirp3-HD/Wavenet path. */
  model?: string;
  /** Style instruction, Gemini-TTS only (e.g. "Ucapkan dengan hangat dan ramah"). */
  stylePrompt?: string;
  sampleRate: number;
}

/**
 * Build the text:synthesize body. Two model families share one endpoint:
 *  - Chirp3-HD / Wavenet / Standard: the model is encoded in the full voice
 *    name (`id-ID-Chirp3-HD-Aoede`); no modelName, no prompt.
 *  - Gemini-TTS: `voice.modelName` selects the model, `voice.name` is the bare
 *    voice ("Kore"), and `input.prompt` can steer delivery style.
 */
export function buildSynthesisBody(text: string, cfg: GoogleTtsConfig): object {
  const input = cfg.model && cfg.stylePrompt ? { prompt: cfg.stylePrompt, text } : { text };
  return {
    input,
    voice: {
      languageCode: cfg.languageCode,
      name: cfg.voice,
      ...(cfg.model ? { modelName: cfg.model } : {}),
    },
    audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: cfg.sampleRate },
  };
}

/**
 * Google Cloud Text-to-Speech (REST). Natural Indonesian via Chirp3-HD voices
 * (`id-ID-Chirp3-HD-*`), or the flagship Gemini-TTS models by setting
 * GOOGLE_TTS_MODEL (voice becomes a bare name like "Kore"). Non-streaming: one
 * request → full audio; the pipeline calls this per sentence, so per-call audio
 * is short and the next sentence is prefetched while the current one plays.
 *
 * Auth: pass an `apiKey` only if the project accepts API keys for Cloud TTS
 * (many don't). Otherwise leave it undefined and authenticate via a service
 * account — set GOOGLE_APPLICATION_CREDENTIALS to the JSON key path (or use
 * Application Default Credentials). Cloud TTS generally requires this OAuth2
 * principal auth, not an API key.
 */
export class GoogleTtsProvider implements TtsProvider {
  readonly sampleRate = 24000;
  private auth?: GoogleAuth;

  constructor(
    private apiKey?: string,
    private voice: string = process.env.GOOGLE_TTS_VOICE ?? "id-ID-Chirp3-HD-Aoede",
    private languageCode: string = process.env.GOOGLE_TTS_LANG ?? "id-ID",
    // set → Gemini-TTS (voice is a bare name); unset → Chirp3-HD/Wavenet (voice is full name)
    private model: string | undefined = process.env.GOOGLE_TTS_MODEL || undefined,
    private stylePrompt: string | undefined = process.env.GOOGLE_TTS_PROMPT || undefined,
  ) {
    // no API key → OAuth2 via service account / ADC (the library caches + refreshes tokens)
    if (!apiKey) this.auth = new GoogleAuth({ scopes: CLOUD_SCOPE });
  }

  /** URL + auth header for the current credential mode. */
  private async endpoint(): Promise<{ url: string; headers: Record<string, string> }> {
    if (this.apiKey) return { url: `${SYNTHESIZE_URL}?key=${this.apiKey}`, headers: {} };
    const token = await this.auth?.getAccessToken();
    if (!token) throw new Error("Google TTS: no credentials (set GOOGLE_APPLICATION_CREDENTIALS)");
    return { url: SYNTHESIZE_URL, headers: { authorization: `Bearer ${token}` } };
  }

  private async post(text: string, withPrompt: boolean, signal?: AbortSignal): Promise<Response> {
    const { url, headers } = await this.endpoint();
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(
        buildSynthesisBody(text, {
          voice: this.voice,
          languageCode: this.languageCode,
          model: this.model,
          stylePrompt: withPrompt ? this.stylePrompt : undefined,
          sampleRate: this.sampleRate,
        }),
      ),
      signal: signal ?? null,
    });
  }

  async *synthesize(text: string, opts?: { signal?: AbortSignal }): AsyncIterable<AudioChunk> {
    let res = await this.post(text, true, opts?.signal);
    // Gemini-TTS's Vertex safety filter false-positives on the style prompt for
    // some benign phrases (deterministically — e.g. "Baik." + prompt always 400s).
    // Retry without the prompt rather than let the utterance go silent.
    if (res.status === 400 && this.model && this.stylePrompt) {
      const body = await res.text();
      if (/usage guidelines|INVALID_ARGUMENT/i.test(body)) {
        console.warn(JSON.stringify({ evt: "gtts_prompt_dropped", text: text.slice(0, 60) }));
        res = await this.post(text, false, opts?.signal);
      } else {
        throw new Error(`Google TTS 400 (${this.model}/${this.voice}): ${body}`);
      }
    }
    if (!res.ok) {
      const detail = this.model ? `${this.model}/${this.voice}` : this.voice;
      throw new Error(`Google TTS ${res.status} (${detail}): ${await res.text()}`);
    }
    const { audioContent } = (await res.json()) as { audioContent?: string };
    if (opts?.signal?.aborted || !audioContent) return;
    yield { pcm: wavToPcm(Buffer.from(audioContent, "base64")), sampleRate: this.sampleRate };
  }
}
