import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSynthesisBody, GoogleTtsProvider, wavToPcm } from "./google-tts.js";

/** Build a minimal LINEAR16 WAV around the given samples. */
function makeWav(samples: number[]): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => {
    data.writeInt16LE(s, i * 2);
  });
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Minimal LINEAR16 WAV (1 sample) as base64, for a fake successful response. */
function fakeAudioB64(): string {
  const h = Buffer.alloc(46);
  h.write("RIFF", 0);
  h.writeUInt32LE(38, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(2, 40);
  h.writeInt16LE(123, 44);
  return h.toString("base64");
}

describe("safety-filter retry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("drops the style prompt and retries on a Gemini-TTS safety 400", async () => {
    const bodies: { hasPrompt: boolean }[] = [];
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const parsed = JSON.parse(init.body) as { input: { prompt?: string } };
      bodies.push({ hasPrompt: parsed.input.prompt !== undefined });
      if (parsed.input.prompt !== undefined) {
        return new Response(JSON.stringify({ error: { message: "violates usage guidelines" } }), {
          status: 400,
        });
      }
      return new Response(JSON.stringify({ audioContent: fakeAudioB64() }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tts = new GoogleTtsProvider(
      "fake-key",
      "Zephyr",
      "id-ID",
      "gemini-3.1-flash-tts-preview",
      "Nada hangat",
    );
    const chunks = [];
    for await (const c of tts.synthesize("Baik.")) chunks.push(c);

    expect(bodies).toEqual([{ hasPrompt: true }, { hasPrompt: false }]); // tried with, then without
    expect(chunks.length).toBe(1);
  });

  it("does not retry on a non-safety error", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tts = new GoogleTtsProvider(
      "fake-key",
      "Zephyr",
      "id-ID",
      "gemini-3.1-flash-tts-preview",
      "Nada hangat",
    );
    await expect(async () => {
      for await (const _ of tts.synthesize("Baik.")) {
      }
    }).rejects.toThrow("Google TTS 429");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("buildSynthesisBody", () => {
  it("Chirp3-HD path: full voice name, no modelName, no prompt", () => {
    const body = buildSynthesisBody("halo", {
      voice: "id-ID-Chirp3-HD-Aoede",
      languageCode: "id-ID",
      sampleRate: 24000,
    }) as {
      input: { text: string; prompt?: string };
      voice: { name: string; modelName?: string };
    };
    expect(body.voice.name).toBe("id-ID-Chirp3-HD-Aoede");
    expect(body.voice.modelName).toBeUndefined();
    expect(body.input.prompt).toBeUndefined();
    expect(body.input.text).toBe("halo");
  });

  it("Gemini-TTS path: bare voice, modelName, and style prompt", () => {
    const body = buildSynthesisBody("halo", {
      voice: "Kore",
      languageCode: "id-ID",
      model: "gemini-2.5-flash-tts",
      stylePrompt: "Ucapkan dengan hangat",
      sampleRate: 24000,
    }) as {
      input: { text: string; prompt?: string };
      voice: { name: string; modelName?: string };
    };
    expect(body.voice.name).toBe("Kore");
    expect(body.voice.modelName).toBe("gemini-2.5-flash-tts");
    expect(body.input.prompt).toBe("Ucapkan dengan hangat");
  });
});

describe("wavToPcm", () => {
  it("extracts PCM samples from a LINEAR16 WAV container", () => {
    const pcm = wavToPcm(makeWav([0, 1000, -1000, 32767, -32768]));
    expect(Array.from(pcm)).toEqual([0, 1000, -1000, 32767, -32768]);
  });

  it("skips a LIST chunk before data", () => {
    const base = makeWav([5, 6, 7]);
    // splice a bogus "LIST" chunk (4 bytes) right after the fmt chunk (offset 36)
    const list = Buffer.alloc(12);
    list.write("LIST", 0);
    list.writeUInt32LE(4, 4);
    list.writeUInt32LE(0xdeadbeef, 8);
    const spliced = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
    expect(Array.from(wavToPcm(spliced))).toEqual([5, 6, 7]);
  });

  it("throws when there is no data chunk", () => {
    const noData = Buffer.alloc(12);
    noData.write("RIFF", 0);
    noData.write("WAVE", 8);
    expect(() => wavToPcm(noData)).toThrow("no data chunk");
  });
});
