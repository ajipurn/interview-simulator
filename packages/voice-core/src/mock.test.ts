import { describe, expect, it } from "vitest";
import { MockLlmProvider, MockSttProvider, MockTtsProvider } from "./mock.js";

function frame(amplitude: number, samples = 960, sampleRate = 48000) {
  const pcm = new Int16Array(samples).fill(amplitude);
  return { pcm, sampleRate };
}

describe("MockSttProvider", () => {
  it("emits a scripted final after speech then silence", async () => {
    const finals: string[] = [];
    let speechStarts = 0;
    const stream = await new MockSttProvider(["halo selia"]).start({
      onFinal: (t) => finals.push(t),
      onSpeechStart: () => speechStarts++,
    });
    // 200ms of speech (10 x 20ms frames), then 700ms of silence
    for (let i = 0; i < 10; i++) stream.pushAudio(frame(3000));
    for (let i = 0; i < 35; i++) stream.pushAudio(frame(0));
    expect(speechStarts).toBe(1);
    expect(finals).toEqual(["halo selia"]);
  });
});

describe("MockLlmProvider", () => {
  it("streams a scripted reply and stops on abort", async () => {
    const llm = new MockLlmProvider(["satu dua tiga empat"], 0);
    const ac = new AbortController();
    let out = "";
    for await (const d of llm.stream([], { signal: ac.signal })) {
      out += d;
      if (out.includes("dua")) ac.abort();
    }
    expect(out.trim()).toBe("satu dua");
  });

  it("returns a fixture rubric for rubric-shaped prompts", async () => {
    const llm = new MockLlmProvider([], 0);
    const raw = await llm.complete([
      {
        role: "user",
        content: 'Balas HANYA JSON valid: {"competencies": [{"rubricLevels": ...}]}',
      },
    ]);
    const parsed = JSON.parse(raw) as { competencies: { rubricLevels: unknown[] }[] };
    expect(parsed.competencies.length).toBeGreaterThanOrEqual(3);
    expect(parsed.competencies.every((c) => c.rubricLevels.length === 5)).toBe(true);
  });
});

describe("MockTtsProvider", () => {
  it("yields 24kHz pcm chunks", async () => {
    const tts = new MockTtsProvider();
    let samples = 0;
    for await (const chunk of tts.synthesize("Halo!")) {
      expect(chunk.sampleRate).toBe(24000);
      samples += chunk.pcm.length;
    }
    expect(samples).toBeGreaterThan(0);
  });
});
