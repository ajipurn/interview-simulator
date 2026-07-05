import { describe, expect, it, vi } from "vitest";
import { type DgMessage, reduceDgMessage } from "./deepgram.js";
import type { SttEvents } from "./types.js";

const results = (transcript: string, flags: Partial<DgMessage> = {}): DgMessage => ({
  type: "Results",
  channel: { alternatives: [{ transcript }] },
  is_final: false,
  speech_final: false,
  ...flags,
});

function makeEvents() {
  return {
    onFinal: vi.fn(),
    onPartial: vi.fn(),
    onSpeechStart: vi.fn(),
  } satisfies SttEvents;
}

describe("reduceDgMessage", () => {
  it("accumulates is_final segments and emits on speech_final", () => {
    const events = makeEvents();
    let u = "";
    u = reduceDgMessage(results("halo nama saya", { is_final: true }), u, events);
    expect(events.onFinal).not.toHaveBeenCalled();
    u = reduceDgMessage(results("budi", { is_final: true, speech_final: true }), u, events);
    expect(events.onFinal).toHaveBeenCalledWith("halo nama saya budi");
    expect(u).toBe("");
  });

  it("emits buffered utterance on UtteranceEnd when speech_final never fired", () => {
    const events = makeEvents();
    let u = "";
    u = reduceDgMessage(results("jawaban di ruangan berisik", { is_final: true }), u, events);
    u = reduceDgMessage({ type: "UtteranceEnd" }, u, events);
    expect(events.onFinal).toHaveBeenCalledWith("jawaban di ruangan berisik");
    expect(u).toBe("");
  });

  it("ignores UtteranceEnd after speech_final already emitted", () => {
    const events = makeEvents();
    let u = "";
    u = reduceDgMessage(
      results("sudah selesai", { is_final: true, speech_final: true }),
      u,
      events,
    );
    u = reduceDgMessage({ type: "UtteranceEnd" }, u, events);
    expect(events.onFinal).toHaveBeenCalledTimes(1);
  });

  it("forwards interim transcripts as partials with accumulated prefix", () => {
    const events = makeEvents();
    let u = "";
    u = reduceDgMessage(results("bagian awal", { is_final: true }), u, events);
    reduceDgMessage(results("lanjutan"), u, events);
    expect(events.onPartial).toHaveBeenCalledWith("bagian awal lanjutan");
  });

  it("relays SpeechStarted", () => {
    const events = makeEvents();
    reduceDgMessage({ type: "SpeechStarted" }, "", events);
    expect(events.onSpeechStart).toHaveBeenCalled();
  });
});
