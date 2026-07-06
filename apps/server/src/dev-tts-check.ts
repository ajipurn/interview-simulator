/** One-shot TTS probe: synthesize a line with the configured provider and report. */
import { ttsFromEnv } from "@selia/voice-core";

const tts = ttsFromEnv();
console.log("provider:", process.env.TTS_PROVIDER ?? "mock", "| sampleRate:", tts.sampleRate);
try {
  let chunks = 0;
  let bytes = 0;
  const t0 = Date.now();
  for await (const c of tts.synthesize("Halo, ini tes suara interviewer.")) {
    chunks++;
    bytes += c.pcm.byteLength;
  }
  const secs = bytes / 2 / tts.sampleRate;
  console.log(
    `TTS OK — ${chunks} chunks, ${(bytes / 1024).toFixed(0)}KB ≈ ${secs.toFixed(1)}s audio, ttfb+synth ${Date.now() - t0}ms`,
  );
} catch (err) {
  console.error("TTS FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
}
