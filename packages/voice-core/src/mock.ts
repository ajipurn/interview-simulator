import type {
  AudioChunk,
  LlmMessage,
  LlmOptions,
  LlmProvider,
  SttEvents,
  SttProvider,
  SttStream,
  TtsProvider,
} from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_SCRIPT = [
  "Halo, nama saya kandidat demo.",
  "Saya punya pengalaman dua tahun di customer service.",
  "Tantangan terbesarnya waktu itu menangani komplain pelanggan besar.",
  "Hasilnya pelanggan tetap lanjut berlangganan.",
];

/**
 * Mock STT: naive energy-based VAD over incoming audio. When it detects
 * speech followed by ~600ms of silence, it emits the next scripted utterance.
 * Lets the whole room flow run offline — the "transcript" is the script.
 */
export class MockSttProvider implements SttProvider {
  constructor(private script: string[] = DEFAULT_SCRIPT) {}

  async start(events: SttEvents): Promise<SttStream> {
    let idx = 0;
    let speaking = false;
    let speechMs = 0;
    let silenceMs = 0;
    const script = this.script;

    return {
      pushAudio(chunk: AudioChunk) {
        const frameMs = (chunk.pcm.length / chunk.sampleRate) * 1000;
        let sum = 0;
        for (const s of chunk.pcm) sum += s * s;
        const rms = Math.sqrt(sum / (chunk.pcm.length || 1));

        if (rms > 500) {
          speechMs += frameMs;
          silenceMs = 0;
          if (!speaking && speechMs > 120) {
            speaking = true;
            events.onSpeechStart?.();
          }
        } else if (speaking) {
          silenceMs += frameMs;
          if (silenceMs > 600) {
            speaking = false;
            speechMs = 0;
            const text = script[idx % script.length] ?? "";
            idx++;
            events.onFinal(text);
          }
        } else {
          speechMs = 0;
        }
      },
      close: async () => {},
    };
  }
}

const DEFAULT_RESPONSES = [
  "Halo! Aku Selia. Senang ketemu kamu. Gimana kabarnya hari ini?",
  "Oke, menarik. Boleh ceritakan lebih detail bagian yang paling menantang?",
  "Baik, aku paham. Terus, apa hasil akhirnya buat tim kamu?",
  "Terima kasih sudah berbagi. Ada lagi yang mau kamu tambahkan?",
];

/**
 * Structured-output prompts (scoring, feedback) get deterministic fixture JSON
 * so the whole post-interview pipeline runs offline. Detection is by prompt
 * shape, mirroring what a real model would be asked to produce.
 */
function mockStructuredReply(prompt: string): string | null {
  if (prompt.includes('"competencyScores"')) {
    const ids = [...prompt.matchAll(/- id: (\S+) \|/g)].map((m) => m[1]);
    const seqs = [...prompt.matchAll(/\[(\d+)\] KANDIDAT:/g)].map((m) => Number(m[1]));
    const seq = seqs[1] ?? seqs[0] ?? 0;
    return JSON.stringify({
      competencyScores: ids.map((id) => ({
        competencyId: id,
        score: 3,
        justification:
          "Jawaban cukup konkret dengan peran pribadi yang jelas, hasil kurang terukur.",
        evidenceQuotes: [{ turnSeq: seq, quote: "jawaban kandidat (mock)" }],
      })),
      summary:
        "Kandidat mengikuti seluruh sesi dengan kooperatif. Jawaban umumnya relevan dengan pertanyaan. " +
        "Beberapa contoh cukup konkret. Hasil kerja belum selalu terukur. Secara keseluruhan layak dipertimbangkan.",
      redFlags: [],
      recommendation: "CONSIDER",
    });
  }
  if (prompt.includes('"rubricLevels"')) {
    const mockLevels = (name: string) => [
      { level: 1, descriptor: `Tidak menunjukkan ${name}; jawaban kosong atau di luar topik.` },
      { level: 2, descriptor: `${name} lemah; contoh samar tanpa peran pribadi yang jelas.` },
      { level: 3, descriptor: `${name} cukup; contoh nyata namun hasil belum terukur.` },
      { level: 4, descriptor: `${name} baik; contoh spesifik dengan peran dan hasil jelas.` },
      { level: 5, descriptor: `${name} sangat kuat; dampak terukur dan refleksi mendalam.` },
    ];
    return JSON.stringify({
      competencies: [
        {
          name: "Komunikasi",
          description: "Menyampaikan ide dengan jelas, runtut, dan mudah dipahami",
          weight: 2,
          rubricLevels: mockLevels("komunikasi"),
        },
        {
          name: "Penyelesaian Masalah",
          description: "Mengurai masalah dan mengambil tindakan yang efektif",
          weight: 1,
          rubricLevels: mockLevels("penyelesaian masalah"),
        },
        {
          name: "Orientasi Hasil",
          description: "Fokus pada target dan dampak kerja yang terukur",
          weight: 1,
          rubricLevels: mockLevels("orientasi hasil"),
        },
      ],
    });
  }
  if (prompt.includes('"probingPoints"')) {
    return JSON.stringify({
      profile: {
        summary: "Kandidat mock dengan 2 tahun pengalaman customer service.",
        experiences: [
          {
            company: "PT Mock Sejahtera",
            role: "Customer Service",
            start: "2024",
            end: "2026",
            highlights: ["Menangani 40+ tiket per hari"],
          },
        ],
        education: [{ institution: "Universitas Mock", degree: "D3" }],
        skills: ["komunikasi", "CRM"],
        projects: [],
        probingPoints: ["klaim 40+ tiket per hari — gali cara menghitungnya"],
      },
      confidence: 0.85,
      // "TANPA-EMAIL" in the CV text simulates a CV without contact info (tests the manual-fill path)
      contact: {
        name: "Mock Kandidat",
        ...(prompt.includes("TANPA-EMAIL") ? {} : { email: "mock.kandidat@example.com" }),
        phone: "+6281234567890",
      },
    });
  }
  if (prompt.includes('"strengths"')) {
    return JSON.stringify({
      strengths: [
        "Kamu menjelaskan pengalamanmu dengan runtut dan mudah diikuti.",
        "Kamu kooperatif menjawab semua pertanyaan sampai selesai.",
      ],
      growthAreas: ["Tambahkan angka atau dampak konkret saat menceritakan hasil kerjamu."],
      tips: "Gunakan pola situasi-tugas-aksi-hasil supaya ceritamu makin meyakinkan.",
    });
  }
  return null;
}

/** Mock LLM: cycles scripted replies, streamed word-by-word to mimic TTFT + token cadence. */
export class MockLlmProvider implements LlmProvider {
  private i = 0;
  constructor(
    private responses: string[] = DEFAULT_RESPONSES,
    private ttftMs = 250,
  ) {}

  async *stream(messages: LlmMessage[], opts?: LlmOptions): AsyncIterable<string> {
    const structured = mockStructuredReply(messages.map((m) => m.content).join("\n"));
    const text = structured ?? this.responses[this.i % this.responses.length] ?? "";
    if (!structured) this.i++;
    await sleep(this.ttftMs);
    for (const word of text.split(" ")) {
      if (opts?.signal?.aborted) return;
      yield `${word} `;
      await sleep(15);
    }
  }

  async complete(messages: LlmMessage[], opts?: LlmOptions): Promise<string> {
    const structured = mockStructuredReply(messages.map((m) => m.content).join("\n"));
    if (structured) return structured;
    let out = "";
    for await (const d of this.stream(messages, opts)) out += d;
    return out.trim();
  }
}

/**
 * Mock TTS: a soft 330Hz tone whose duration tracks text length, streamed in
 * 20ms frames. Enough to exercise playback, barge-in, and latency measurement.
 */
export class MockTtsProvider implements TtsProvider {
  readonly sampleRate = 24000;

  async *synthesize(text: string, opts?: { signal?: AbortSignal }): AsyncIterable<AudioChunk> {
    await sleep(80); // simulated TTFB
    const durationMs = Math.min(Math.max(text.length * 55, 400), 8000);
    const frameSamples = this.sampleRate / 50; // 20ms
    const frames = Math.ceil((durationMs / 1000) * this.sampleRate) / frameSamples;
    let t = 0;
    for (let f = 0; f < frames; f++) {
      if (opts?.signal?.aborted) return;
      const pcm = new Int16Array(frameSamples);
      for (let i = 0; i < frameSamples; i++) {
        pcm[i] = Math.round(Math.sin((2 * Math.PI * 330 * t) / this.sampleRate) * 4000);
        t++;
      }
      yield { pcm, sampleRate: this.sampleRate };
      await sleep(18); // slightly faster than real time so the buffer stays ahead
    }
  }
}
