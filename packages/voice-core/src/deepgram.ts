import WebSocket from "ws";
import type { AudioChunk, SttEvents, SttProvider, SttStream } from "./types.js";

const KEEPALIVE_MS = 8000;

/** One parsed message from the Deepgram live-transcription socket. */
export interface DgMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
}

/**
 * Reduce one Deepgram message against the utterance accumulated so far.
 * Returns the new accumulated utterance.
 *
 * Finalization follows Deepgram's recommended dual trigger: emit on
 * `speech_final` (endpointing), and on `UtteranceEnd` (word-gap backstop) when
 * background noise kept `speech_final` from ever firing. After a speech_final
 * emit the accumulator is empty, so the trailing UtteranceEnd is a no-op.
 */
export function reduceDgMessage(msg: DgMessage, utterance: string, events: SttEvents): string {
  if (msg.type === "SpeechStarted") {
    events.onSpeechStart?.();
    return utterance;
  }
  if (msg.type === "UtteranceEnd") {
    if (utterance) {
      events.onFinal(utterance);
      return "";
    }
    return utterance;
  }
  if (msg.type !== "Results") return utterance;
  const transcript = msg.channel?.alternatives?.[0]?.transcript ?? "";
  if (!msg.is_final) {
    if (transcript) events.onPartial?.(`${utterance} ${transcript}`.trim());
    return utterance;
  }
  if (transcript) utterance = `${utterance} ${transcript}`.trim();
  if (msg.speech_final && utterance) {
    events.onFinal(utterance);
    return "";
  }
  return utterance;
}

/**
 * Deepgram streaming STT over WebSocket. Indonesian (`language=id`),
 * linear16 mono, server-side endpointing + VAD events for barge-in.
 */
export class DeepgramSttProvider implements SttProvider {
  constructor(
    private apiKey: string,
    private sampleRate = 48000,
    private model = process.env.DEEPGRAM_MODEL ?? "nova-3",
  ) {}

  async start(events: SttEvents): Promise<SttStream> {
    const url = new URL("wss://api.deepgram.com/v1/listen");
    const params: Record<string, string> = {
      model: this.model,
      language: "id",
      encoding: "linear16",
      sample_rate: String(this.sampleRate),
      channels: "1",
      interim_results: "true",
      // 500ms endpointing: snappy turn-taking without clipping most mid-answer
      // thinking pauses. Lower → Selia jumps in sooner but risks replying to a
      // fragment; raise toward 700 if candidates get cut off. Tunable by ear.
      endpointing: process.env.DEEPGRAM_ENDPOINTING_MS ?? "500",
      // Backstop only for when noise/breath stops speech_final from ever firing.
      // 1000 (Deepgram's floor) keeps that sporadic dead-air case short; this is
      // the "kadang lama" the candidate feels when the room isn't quiet.
      utterance_end_ms: process.env.DEEPGRAM_UTTERANCE_END_MS ?? "1000",
      vad_events: "true",
      smart_format: "true",
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const ws = new WebSocket(url, { headers: { Authorization: `Token ${this.apiKey}` } });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    // Segments marked is_final accumulate until speech_final/UtteranceEnd closes the utterance.
    let utterance = "";

    let debugCount = 0;
    ws.on("message", (raw) => {
      if (process.env.DEEPGRAM_DEBUG === "1" && debugCount < 8) {
        debugCount++;
        console.log(JSON.stringify({ evt: "dg_raw", msg: raw.toString().slice(0, 220) }));
      }
      let msg: DgMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      utterance = reduceDgMessage(msg, utterance, events);
    });
    ws.on("error", (err) => events.onError?.(err instanceof Error ? err : new Error(String(err))));
    let expectClose = false;
    ws.on("close", (code, reason) => {
      if (!expectClose) {
        events.onError?.(
          new Error(`deepgram ws closed unexpectedly: ${code} ${reason.toString()}`),
        );
      }
    });

    const keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
    }, KEEPALIVE_MS);

    return {
      pushAudio(chunk: AudioChunk) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(Buffer.from(chunk.pcm.buffer, chunk.pcm.byteOffset, chunk.pcm.byteLength));
      },
      close: async () => {
        expectClose = true;
        clearInterval(keepalive);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
        // give the flushed finals a moment to arrive, then emit whatever is buffered
        await new Promise((r) => setTimeout(r, 1500));
        if (utterance) {
          events.onFinal(utterance);
          utterance = "";
        }
        ws.close();
      },
    };
  }
}
