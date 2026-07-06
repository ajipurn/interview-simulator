import type { AudioChunk, SttProvider, SttStream, TtsProvider } from "@selia/voice-core";
import type { LatencyRecorder } from "./latency.js";

/** Produces the AI's reply to a candidate utterance as streaming text. */
export type Responder = (userText: string, signal: AbortSignal) => AsyncIterable<string>;

export interface AudioSink {
  write(chunk: AudioChunk): void;
  /** Drop any queued/buffered audio immediately (barge-in). */
  clear(): void;
}

export interface PipelineEvents {
  onCaption?(speaker: "ai" | "candidate", text: string): void;
  onError?(err: Error): void;
}

/**
 * Split streaming LLM text into sentence-sized chunks so TTS can start before
 * the full reply is generated. Sentences shorter than MIN_CHUNK merge with the
 * next one: a chunk whose audio is shorter than the next chunk's TTS TTFB
 * leaves an audible gap between sentences.
 */
const MIN_CHUNK = 60;
export async function* sentenceChunks(
  src: AsyncIterable<string>,
  onFirstDelta?: () => void,
): AsyncIterable<string> {
  let buf = "";
  let out = "";
  let first = true;
  for await (const delta of src) {
    if (first) {
      onFirstDelta?.();
      first = false;
    }
    buf += delta;
    const parts = buf.split(/(?<=[.!?…])\s+/);
    if (parts.length > 1) {
      for (const p of parts.slice(0, -1)) {
        const s = p.trim();
        if (!s) continue;
        out = out ? `${out} ${s}` : s;
        if (out.length >= MIN_CHUNK) {
          yield out;
          out = "";
        }
      }
      buf = parts[parts.length - 1] ?? "";
    } else if (buf.length > 200) {
      // no sentence boundary in a long stretch — flush anyway to keep latency bounded
      yield `${out ? `${out} ` : ""}${buf.trim()}`;
      out = "";
      buf = "";
    }
  }
  const rest = `${out ? `${out} ` : ""}${buf.trim()}`.trim();
  if (rest) yield rest;
}

/** Listener noises that must not interrupt or advance the interview ("iya", "oke oke", "iya ya"). */
const BACKCHANNEL = /^((iya|ya|oke|ok|oh|baik|siap|betul|hmm+|he+m*|he[- ]?eh)[\s.,!?…]*)+$/i;

/** Lowercase, strip punctuation → token list — for comparing STT vs spoken text. */
const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Length of the longest common subsequence of two token lists. */
function lcsLen(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

/**
 * Ordered similarity by LCS ratio over the longer list (0..1). A near-verbatim
 * echo of a whole sentence scores ~1; an answer reusing a few topic words scores
 * low — used to drop a *final* that is really Selia's voice looped back.
 */
export function seqSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  return lcsLen(a, b) / Math.max(a.length, b.length);
}

/**
 * How fully `part` is contained (in order) within `whole`, 0..1. A partial that
 * is entirely a fragment of one of Selia's sentences (pure echo) scores ~1; the
 * moment the candidate adds their own words it drops — used on partials, which
 * are fragments by nature so max-ratio would always read low.
 */
export function containment(part: string[], whole: string[]): number {
  if (part.length === 0) return 0;
  return lcsLen(part, whole) / part.length;
}

/**
 * Core conversational loop, transport-agnostic:
 * candidate audio → STT (endpointing) → responder → TTS → audio sink.
 * Supports barge-in: candidate speech aborts the in-flight reply and clears
 * buffered audio.
 */
export class VoicePipeline {
  private sttStream: SttStream | null = null;
  private current: AbortController | null = null;
  /** Recent AI sentences (tokenized) — self-echo compares against these. */
  private recentAiSentences: string[][] = [];
  /** Estimated wall-clock ms when all audio written so far finishes playing. */
  private audioUntilMs = 0;
  /** Text of the sentence currently being spoken — what a resume re-speaks. */
  private speakingText = "";
  private resumeTimer: NodeJS.Timeout | null = null;
  private lastResumeAt = Number.NEGATIVE_INFINITY;
  private lastPartialAt = Number.NEGATIVE_INFINITY;
  /** AI-caption timers, each paced to when its sentence starts playing; dropped on barge-in. */
  private captionTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private deps: {
      stt: SttProvider;
      tts: TtsProvider;
      responder: Responder;
      sink: AudioSink;
      latency: LatencyRecorder;
      events?: PipelineEvents;
      /** Pre-synthesized short acknowledgements played while the responder thinks. */
      fillers?: AudioChunk[][];
      /** How long to wait for a final after a barge-in before calling it false. */
      falseInterruptResumeMs?: number;
    },
  ) {}

  async start(): Promise<void> {
    this.sttStream = await this.deps.stt.start({
      // Barge-in on transcribed words, not raw VAD: SpeechStarted fires on any
      // mic energy (noise, breath, echo) and was chopping the AI mid-word.
      onPartial: (text) => {
        this.lastPartialAt = performance.now(); // candidate is vocalizing — defer any resume
        const t = text.trim();
        if (t.split(/\s+/).length < 2 || BACKCHANNEL.test(t)) return;
        if (this.isEchoFragment(t)) return; // her own voice from the candidate's speaker
        if (this.current || this.stillSpeaking()) {
          console.log(JSON.stringify({ evt: "barge_in", partial: t.slice(0, 80) }));
          this.armResume();
        }
        this.bargeIn();
      },
      onFinal: (text) => {
        // echo of her own sentence transcribed as a "candidate answer" would
        // barge her in and advance the engine on garbage — drop it
        if (this.stillSpeaking(800) && this.isSelfEcho(text)) {
          console.log(JSON.stringify({ evt: "stt_echo_dropped", text: text.slice(0, 80) }));
          return;
        }
        void this.respond(text).catch((err) =>
          this.deps.events?.onError?.(err instanceof Error ? err : new Error(String(err))),
        );
      },
      onError: (err) => this.deps.events?.onError?.(err),
    });
  }

  pushAudio(chunk: AudioChunk): void {
    this.sttStream?.pushAudio(chunk);
  }

  async stop(): Promise<void> {
    this.cancelResume();
    this.bargeIn();
    await this.sttStream?.close();
    this.sttStream = null;
  }

  /**
   * A partial barged Selia in, but if no final follows, it was noise or a nod —
   * not a turn. Resume the cut sentence instead of leaving it half-said and
   * the room silent (the LiveKit "false interruption" pattern).
   */
  private armResume(): void {
    const cut = this.speakingText;
    if (!cut) return;
    // one resume per window — a noisy room must not loop "maaf, lanjut ya"
    if (performance.now() - this.lastResumeAt < 10_000) return;
    // default outlasts Deepgram's worst final-after-last-partial gap
    // (endpointing + segment flush) — resuming late beats talking over a
    // candidate whose final is still in flight; a real final self-cancels this
    const wait = this.deps.falseInterruptResumeMs ?? 3500;
    const fire = () => {
      this.resumeTimer = null;
      if (this.current) return; // a real turn arrived meanwhile
      // partials still flowing = candidate mid-utterance (final pending) —
      // resuming now would talk over them; wait for their speech to die out
      const sincePartial = performance.now() - this.lastPartialAt;
      if (sincePartial < wait) {
        this.resumeTimer = setTimeout(fire, wait - sincePartial);
        return;
      }
      this.lastResumeAt = performance.now();
      console.log(JSON.stringify({ evt: "false_interrupt_resume", text: cut.slice(0, 80) }));
      void this.say(`Maaf, aku lanjutkan ya. ${cut}`).catch(() => {});
    };
    this.cancelResume();
    this.resumeTimer = setTimeout(fire, wait);
  }

  private cancelResume(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  /** True while written audio is still (estimated to be) playing out. */
  private stillSpeaking(graceMs = 0): boolean {
    return performance.now() < this.audioUntilMs + graceMs;
  }

  /**
   * A *final* that is (near-)verbatim one of Selia's recent sentences — her own
   * voice looped back, not an answer. Ordered whole-sentence similarity, so an
   * answer reusing a few topic words is NOT echo (that false-drop = lost turn).
   */
  private isSelfEcho(text: string): boolean {
    const tokens = tokenize(text);
    if (tokens.length < 3) return false; // too short to tell echo from a real reply
    return this.recentAiSentences.some((s) => seqSimilarity(tokens, s) >= 0.7);
  }

  /**
   * A *partial* (a fragment by nature) that sits entirely inside one of Selia's
   * sentences = echo of her voice; the moment the candidate adds their own words
   * containment drops and a genuine barge-in is allowed through.
   */
  private isEchoFragment(text: string): boolean {
    const tokens = tokenize(text);
    if (tokens.length < 2) return false;
    return this.recentAiSentences.some((s) => containment(tokens, s) >= 0.8);
  }

  private noteAiSpeech(text: string): void {
    this.recentAiSentences.push(tokenize(text));
    if (this.recentAiSentences.length > 6) this.recentAiSentences.shift();
  }

  /**
   * Show an AI caption when its audio actually starts playing, not when it is
   * synthesized. Synthesis runs ahead of realtime (one-sentence lookahead), so
   * emitting at synth time made the text race seconds ahead of the voice — worst
   * on long topic-transition replies. `startAtMs` is the playout end of all audio
   * queued so far = when this sentence begins being heard.
   */
  private emitAiCaption(text: string, startAtMs: number, signal: AbortSignal): void {
    const onCaption = this.deps.events?.onCaption;
    if (!onCaption) return;
    const delay = startAtMs - performance.now();
    if (delay <= 0) {
      onCaption("ai", text);
      return;
    }
    const timer = setTimeout(() => {
      this.captionTimers.delete(timer);
      if (!signal.aborted) onCaption("ai", text);
    }, delay);
    this.captionTimers.add(timer);
  }

  private clearCaptionTimers(): void {
    for (const t of this.captionTimers) clearTimeout(t);
    this.captionTimers.clear();
  }

  /** Write one chunk and advance the playout estimate. */
  private writeChunk(chunk: AudioChunk): void {
    this.deps.sink.write(chunk);
    const durMs = (chunk.pcm.length / chunk.sampleRate) * 1000;
    this.audioUntilMs = Math.max(this.audioUntilMs, performance.now()) + durMs;
  }

  /** Candidate started talking over Selia: stop speaking, keep listening. */
  private bargeIn(): void {
    // captions not yet spoken belong to audio we're about to drop — cancel them
    this.clearCaptionTimers();
    if (this.current) {
      this.current.abort();
      this.current = null;
    }
    // clear even when no generator is in flight — written audio may still be
    // queued/playing long after the respond/say loop finished
    this.deps.sink.clear();
    this.audioUntilMs = 0;
  }

  /**
   * Speak a scripted line (greeting, resume) through the same abort/clear path
   * as replies — a second writer interleaving PCM into the sink garbles audio.
   *
   * Synthesized sentence-by-sentence with one-sentence lookahead: non-streaming
   * TTS providers (Google Cloud) return audio only after synthesizing the whole
   * input, so a long greeting in one call meant 10-15s of dead silence before
   * the first byte — long enough that players talked over it and barged the
   * greeting away before ever hearing it.
   */
  async say(text: string): Promise<void> {
    this.cancelResume();
    this.bargeIn();
    const ac = new AbortController();
    this.current = ac;
    this.speakingText = text;
    this.noteAiSpeech(text);
    const parts = text.split(/(?<=[.!?…])\s+/).filter((s) => s.trim());
    const prepare = (sentence: string) => {
      const iter = this.deps.tts
        .synthesize(sentence, { signal: ac.signal })
        [Symbol.asyncIterator]();
      const first = iter.next();
      // abort can reject this lookahead after we've stopped awaiting it —
      // observe here or the rejection kills the process
      first.catch(() => {});
      return { iter, first };
    };
    try {
      let first = true;
      let idx = 0;
      let cur = parts.length > 0 ? prepare(parts[idx] ?? "") : null;
      while (cur) {
        idx++;
        // kick off the next sentence's synthesis while this one plays
        const next = idx < parts.length ? prepare(parts[idx] ?? "") : null;
        let res = await cur.first;
        while (!res.done) {
          if (ac.signal.aborted) return;
          // show the caption exactly when its first audio is ready, never before —
          // the greeting has no filler to hide the synth TTFB
          if (first) {
            this.deps.events?.onCaption?.("ai", text);
            first = false;
          }
          this.writeChunk(res.value);
          res = await cur.iter.next();
        }
        cur = next;
      }
    } catch (err) {
      if (!ac.signal.aborted) throw err;
    } finally {
      if (this.current === ac) this.current = null;
    }
  }

  private async respond(userText: string): Promise<void> {
    // "iya"/"hmm" while Selia is mid-sentence is a listener nod, not an answer —
    // responding to it chops her speech and advances the engine on garbage.
    if ((this.current || this.stillSpeaking(300)) && BACKCHANNEL.test(userText.trim())) return;
    this.cancelResume(); // a real final arrived — the barge-in was not false
    this.bargeIn();
    const ac = new AbortController();
    this.current = ac;
    const turn = this.deps.latency.startTurn();
    this.deps.events?.onCaption?.("candidate", userText);

    // Mask planner latency with a short acknowledgement filler.
    const fillers = this.deps.fillers;
    if (fillers && fillers.length > 0) {
      const filler = fillers[Math.floor(Math.random() * fillers.length)];
      if (filler) {
        turn.markFirstAudio();
        for (const chunk of filler) {
          if (ac.signal.aborted) break;
          this.writeChunk(chunk);
        }
      }
    }

    try {
      const sentences = sentenceChunks(this.deps.responder(userText, ac.signal), () =>
        turn.markLlmFirstToken(),
      )[Symbol.asyncIterator]();
      // One sentence of TTS lookahead: synthesis of sentence n+1 starts while
      // n is still being written, hiding the per-sentence TTFB (~0.3-1s) that
      // was audible as a stutter between every sentence.
      const prepare = (sentence: string) => {
        const iter = this.deps.tts
          .synthesize(sentence, { signal: ac.signal })
          [Symbol.asyncIterator]();
        const first = iter.next();
        // abort can reject this lookahead after we've stopped awaiting it —
        // observe here or the rejection kills the process
        first.catch(() => {});
        return { sentence, iter, first };
      };
      const pull = async () => {
        const r = await sentences.next();
        return r.done ? null : prepare(r.value);
      };
      let cur = await pull();
      while (cur) {
        if (ac.signal.aborted) return;
        const nextP = pull();
        // same: an early return on barge-in leaves nextP un-awaited
        nextP.catch(() => {});
        this.speakingText = cur.sentence;
        this.noteAiSpeech(cur.sentence);
        let res = await cur.first;
        // caption only after the first chunk exists (TTFB elapsed). Emitting
        // before the await let the first line — which has no filler ahead of it —
        // beat its own audio. audioUntilMs = when this sentence is heard.
        this.emitAiCaption(cur.sentence, this.audioUntilMs, ac.signal);
        while (!res.done) {
          if (ac.signal.aborted) return;
          turn.markFirstAudio();
          turn.markContentAudio();
          this.writeChunk(res.value);
          res = await cur.iter.next();
        }
        cur = await nextP;
      }
    } catch (err) {
      if (!ac.signal.aborted) throw err;
    } finally {
      turn.end();
      if (this.current === ac) this.current = null;
    }
  }
}
