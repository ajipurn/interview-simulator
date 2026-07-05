import { MPEGDecoder } from "mpg123-decoder";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import type { AudioChunk, TtsProvider } from "./types.js";

/**
 * Edge TTS — Microsoft Edge's read-aloud neural voices (same voices as Azure
 * Speech, incl. id-ID-GadisNeural / id-ID-ArdiNeural). Free, no key.
 *
 * ⚠ Unofficial endpoint: fine for development and testing, do NOT ship a paid
 * pilot on it — swap to Azure Speech (same voices, same quality) or ElevenLabs.
 *
 * The endpoint only emits MP3/WebM, so chunks are decoded to PCM in-process
 * (WASM decoder, no native deps).
 */
export class EdgeTtsProvider implements TtsProvider {
  readonly sampleRate = 24000;

  constructor(private voice: string = process.env.EDGE_TTS_VOICE ?? "id-ID-GadisNeural") {}

  async *synthesize(text: string, opts?: { signal?: AbortSignal }): AsyncIterable<AudioChunk> {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const decoder = new MPEGDecoder();
    await decoder.ready;
    try {
      const { audioStream } = tts.toStream(text);
      for await (const mp3Chunk of audioStream) {
        if (opts?.signal?.aborted) return;
        const decoded = decoder.decode(new Uint8Array(mp3Chunk as Buffer));
        const f32 = decoded.channelData[0];
        if (!f32 || decoded.samplesDecoded === 0) continue;
        const pcm = new Int16Array(decoded.samplesDecoded);
        for (let i = 0; i < decoded.samplesDecoded; i++) {
          const s = Math.max(-1, Math.min(1, f32[i] ?? 0));
          pcm[i] = Math.round(s * 32767);
        }
        yield { pcm, sampleRate: decoded.sampleRate || this.sampleRate };
      }
    } finally {
      decoder.free();
      tts.close();
    }
  }
}
