/** Mono 16-bit PCM audio. */
export interface AudioChunk {
  pcm: Int16Array;
  sampleRate: number;
}

// --- STT ---

export interface SttEvents {
  /** Endpointed utterance — the candidate finished speaking. */
  onFinal(text: string): void;
  /** Stable partial transcript (may be used to warm the LLM early). */
  onPartial?(text: string): void;
  /** Voice activity detected — used for barge-in. */
  onSpeechStart?(): void;
  onError?(err: Error): void;
}

export interface SttStream {
  pushAudio(chunk: AudioChunk): void;
  close(): Promise<void>;
}

export interface SttProvider {
  start(events: SttEvents): Promise<SttStream>;
}

// --- LLM ---

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmProvider {
  /** Streaming text deltas. */
  stream(messages: LlmMessage[], opts?: LlmOptions): AsyncIterable<string>;
  /** Non-streaming convenience (scoring, rubric generation). */
  complete(messages: LlmMessage[], opts?: LlmOptions): Promise<string>;
}

// --- TTS ---

export interface TtsProvider {
  /** Output sample rate of synthesized chunks. */
  readonly sampleRate: number;
  synthesize(text: string, opts?: { signal?: AbortSignal }): AsyncIterable<AudioChunk>;
}
