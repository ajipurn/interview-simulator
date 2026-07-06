import { AnthropicLlmProvider } from "./anthropic.js";
import { AzureTtsProvider } from "./azure.js";
import { DeepgramSttProvider } from "./deepgram.js";
import { EdgeTtsProvider } from "./edge.js";
import { ElevenLabsTtsProvider } from "./elevenlabs.js";
import { GeminiLlmProvider } from "./gemini.js";
import { GeminiTtsProvider } from "./gemini-tts.js";
import { GoogleTtsProvider } from "./google-tts.js";
import { MockLlmProvider, MockSttProvider, MockTtsProvider } from "./mock.js";
import { AzureOpenAiLlmProvider, OpenAiLlmProvider } from "./openai.js";
import type { LlmProvider, SttProvider, TtsProvider } from "./types.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/**
 * `sampleRate` must match the PCM actually pushed into the stream — Deepgram
 * decodes linear16 at exactly this rate. A mismatch (e.g. 16k audio declared
 * as the 48k default) plays back 3× fast on their end: zero words recognized,
 * no finals, and the interview silently stalls after the greeting.
 */
export function sttFromEnv(sampleRate = 48000): SttProvider {
  switch (process.env.STT_PROVIDER ?? "mock") {
    case "deepgram":
      return new DeepgramSttProvider(required("DEEPGRAM_API_KEY"), sampleRate);
    default: {
      // MOCK_STT_SCRIPT: JSON array of utterances the mock "hears" (E2E fixtures)
      const script = process.env.MOCK_STT_SCRIPT
        ? (JSON.parse(process.env.MOCK_STT_SCRIPT) as string[])
        : undefined;
      return new MockSttProvider(script);
    }
  }
}

export function llmFromEnv(): LlmProvider {
  switch (process.env.LLM_PROVIDER ?? "mock") {
    case "anthropic":
      return new AnthropicLlmProvider(required("ANTHROPIC_API_KEY"));
    case "openai":
      return new OpenAiLlmProvider(required("OPENAI_API_KEY"));
    case "azure-openai":
      return new AzureOpenAiLlmProvider(
        required("AZURE_OPENAI_KEY"),
        required("AZURE_OPENAI_ENDPOINT"),
      );
    case "gemini":
    case "google":
      return new GeminiLlmProvider(required("GEMINI_API_KEY"));
    default:
      return new MockLlmProvider();
  }
}

export function ttsFromEnv(): TtsProvider {
  switch (process.env.TTS_PROVIDER ?? "mock") {
    case "elevenlabs":
      return new ElevenLabsTtsProvider(
        required("ELEVENLABS_API_KEY"),
        required("ELEVENLABS_VOICE_ID"),
      );
    case "gemini":
      return new GeminiTtsProvider(required("GEMINI_API_KEY"));
    case "google-cloud":
    case "gcloud":
      // Chirp3-HD by default (model is in GOOGLE_TTS_VOICE); set GOOGLE_TTS_MODEL
      // to switch to Gemini-TTS. Auth: GOOGLE_TTS_API_KEY if the project accepts
      // API keys, otherwise leave it unset and authenticate via a service account
      // (GOOGLE_APPLICATION_CREDENTIALS) — Cloud TTS usually requires the latter.
      return new GoogleTtsProvider(process.env.GOOGLE_TTS_API_KEY || undefined);
    case "azure":
      return new AzureTtsProvider(required("AZURE_SPEECH_KEY"));
    case "edge":
      return new EdgeTtsProvider();
    default:
      return new MockTtsProvider();
  }
}
