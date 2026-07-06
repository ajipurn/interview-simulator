import type { LlmMessage, LlmOptions, LlmProvider } from "@selia/voice-core";
import { describe, expect, it } from "vitest";
import { InterviewEngine } from "./engine.js";
import { loadState, MemoryKvStore, saveState } from "./store.js";
import type { EngineConfig, EngineEvent, EngineState } from "./types.js";

/** Rule-based LLM stub: first regex matching the prompt wins. */
function testLlm(rules: [RegExp, string | ((prompt: string) => string)][]): LlmProvider {
  const respond = (messages: LlmMessage[]): string => {
    const prompt = messages.map((m) => m.content).join("\n");
    for (const [pattern, out] of rules) {
      if (pattern.test(prompt)) return typeof out === "function" ? out(prompt) : out;
    }
    throw new Error(`no rule for prompt: ${prompt.slice(0, 120)}`);
  };
  return {
    complete: async (messages: LlmMessage[], _opts?: LlmOptions) => respond(messages),
    stream: async function* (messages: LlmMessage[], _opts?: LlmOptions) {
      yield respond(messages);
    },
  };
}

const STAR_COMPLETE = JSON.stringify({ offTopic: false, missing: [], followUp: "" });
const STAR_NEEDS_RESULT = JSON.stringify({
  offTopic: false,
  missing: ["result"],
  followUp: "Kamu bilang komplain besar itu selesai — hasil akhirnya seperti apa?",
});

function fixtureConfig(overrides?: Partial<EngineConfig>): EngineConfig {
  return {
    interviewId: "int-test",
    jobTitle: "Customer Service Officer",
    jdText: "Melayani pelanggan, menangani komplain.",
    candidateName: "Dewi",
    competencies: [
      {
        id: "comp-komunikasi",
        name: "Komunikasi",
        description: "Menyampaikan informasi dengan jelas",
        weight: 1,
        order: 0,
        rubricLevels: [],
      },
      {
        id: "comp-masalah",
        name: "Penanganan Masalah",
        description: "Menyelesaikan komplain",
        weight: 1,
        order: 1,
        rubricLevels: [],
      },
    ],
    cvProfile: {
      summary: "2 tahun customer service di ritel",
      experiences: [{ company: "PT Retail Maju", role: "CS", highlights: ["50 tiket per hari"] }],
      education: [],
      skills: ["komunikasi"],
      projects: [],
      probingPoints: [],
    },
    targetDurationMin: 15,
    maxProbesPerCompetency: 2,
    ...overrides,
  };
}

const DEFAULT_RULES: [RegExp, string | ((p: string) => string)][] = [
  [
    /pertanyaan pembuka.*Komunikasi/is,
    "Saya lihat di CV kamu menangani 50 tiket per hari di PT Retail Maju — ceritakan gimana kamu menjaga komunikasi tetap jelas?",
  ],
  [
    /pertanyaan pembuka.*Penanganan Masalah/is,
    "Ceritakan komplain tersulit yang pernah kamu selesaikan.",
  ],
  [/Analisis jawaban/i, STAR_COMPLETE],
  [
    /Kandidat bertanya/i,
    "Prosesnya masih ada beberapa tahap, tim rekruter yang akan mengabari ya.",
  ],
];

describe("InterviewEngine: happy path", () => {
  it("walks OPENING → core per competency → CANDIDATE_QUESTIONS → CLOSING", async () => {
    const engine = new InterviewEngine(fixtureConfig(), testLlm(DEFAULT_RULES));

    const opening = engine.begin();
    expect(opening.utterance.toLowerCase()).toContain("aku selia");
    // game context: no AI disclosure — the player knows; opener is a warm 1-on-1

    const q1 = await engine.onCandidateAnswer("Siap!");
    expect(q1.utterance).toContain("50 tiket per hari"); // CV-personalized core question

    const q2 = await engine.onCandidateAnswer(
      "Waktu itu saya selalu konfirmasi ulang ke pelanggan, hasilnya salah paham turun.",
    );
    expect(q2.utterance).toContain("komplain tersulit"); // competency 2

    const qCand = await engine.onCandidateAnswer(
      "Saya tenangkan pelanggan, cari akarnya, hasilnya dia lanjut langganan.",
    );
    expect(qCand.utterance).toContain("ada yang mau kamu tanyakan");

    const answer = await engine.onCandidateAnswer("Prosesnya setelah ini gimana ya?");
    expect(answer.utterance).toContain("tim rekruter");
    expect(answer.done).toBe(false);

    // negation word inside a real question must NOT read as "no more questions"
    const answer2 = await engine.onCandidateAnswer("Ada kesempatan remote nggak?");
    expect(answer2.done).toBe(false);
    expect(answer2.utterance).toContain("tim rekruter");

    const closing = await engine.onCandidateAnswer("Tidak ada lagi, terima kasih.");
    expect(closing.done).toBe(true);
    expect(closing.utterance).toContain("Terima kasih");

    const types = engine.state.turns.filter((t) => t.speaker === "AI").map((t) => t.turnType);
    expect(types).toEqual([
      "OPENING",
      "CORE_QUESTION",
      "CORE_QUESTION",
      "CLOSING",
      "CLOSING",
      "CLOSING",
      "CLOSING",
    ]);
  });
});

describe("InterviewEngine: STAR probing", () => {
  it("probes on missing STAR elements, capped at maxProbesPerCompetency", async () => {
    const rules: [RegExp, string][] = [
      [/pertanyaan pembuka/is, "Ceritakan pengalamanmu."],
      [/Analisis jawaban/i, STAR_NEEDS_RESULT], // always incomplete → engine must cap probes
      [/Kandidat bertanya/i, "Oke."],
    ];
    const engine = new InterviewEngine(fixtureConfig(), testLlm(rules));
    engine.begin();
    await engine.onCandidateAnswer("Siap");

    const probe1 = await engine.onCandidateAnswer("Saya pernah menangani komplain besar.");
    expect(probe1.utterance).toContain("hasil akhirnya seperti apa");
    const probe2 = await engine.onCandidateAnswer("Komplainnya soal pengiriman.");
    expect(probe2.utterance).toContain("hasil akhirnya seperti apa");
    // probe budget exhausted → advance to competency 2 even though STAR still incomplete
    const next = await engine.onCandidateAnswer("Pokoknya selesai.");
    expect(next.utterance).toContain("Ceritakan pengalamanmu");

    const probes = engine.state.turns.filter((t) => t.speaker === "AI" && t.turnType === "PROBE");
    expect(probes.length).toBe(2);
    expect(probes.every((p) => p.competencyId === "comp-komunikasi")).toBe(true);
  });

  it("redirects off-topic answers back to the question", async () => {
    const rules: [RegExp, string][] = [
      [/pertanyaan pembuka/is, "Ceritakan pengalamanmu menangani pelanggan."],
      [/Analisis jawaban/i, JSON.stringify({ offTopic: true, missing: [], followUp: "" })],
    ];
    const engine = new InterviewEngine(fixtureConfig(), testLlm(rules));
    engine.begin();
    await engine.onCandidateAnswer("Siap");
    const redirect = await engine.onCandidateAnswer("Ngomong-ngomong gaji di sini berapa ya?");
    expect(redirect.utterance).toContain("kita kembali ke pertanyaan tadi");
    expect(redirect.utterance).toContain("menangani pelanggan");
  });
});

describe("InterviewEngine: guardrails on generated questions", () => {
  it("replaces a prohibited generated question with the safe fallback and audits it", async () => {
    const events: EngineEvent[] = [];
    const rules: [RegExp, string][] = [
      [/pertanyaan pembuka/is, "Apakah kamu sudah menikah dan ada rencana punya anak?"],
      [/Analisis jawaban/i, STAR_COMPLETE],
    ];
    const engine = new InterviewEngine(fixtureConfig(), testLlm(rules), {
      onEvent: (e) => events.push(e),
    });
    engine.begin();
    const q = await engine.onCandidateAnswer("Siap");

    expect(q.utterance).not.toMatch(/menikah|anak/);
    expect(q.utterance).toContain("Komunikasi".toLowerCase());
    const blocked = events.filter((e) => e.type === "guardrail_blocked");
    expect(blocked.length).toBe(1);
    expect(blocked[0]?.detail.topic).toBe("marital_status");
  });
});

describe("InterviewEngine: time budgeting", () => {
  it("skips probes when behind schedule but still covers all competencies", async () => {
    const events: EngineEvent[] = [];
    let now = 0;
    const rules: [RegExp, string][] = [
      [/pertanyaan pembuka/is, "Ceritakan pengalamanmu."],
      [/Analisis jawaban/i, STAR_NEEDS_RESULT],
    ];
    const engine = new InterviewEngine(fixtureConfig({ targetDurationMin: 15 }), testLlm(rules), {
      clock: () => now,
      onEvent: (e) => events.push(e),
    });
    engine.begin();
    await engine.onCandidateAnswer("Siap");

    now = 14 * 60_000; // 14 of 15 minutes gone, still on competency 1
    const next = await engine.onCandidateAnswer("Saya pernah menangani komplain.");
    // no probe despite missing result — advances straight to competency 2
    expect(next.utterance).toContain("Ceritakan pengalamanmu");
    expect(engine.state.competencyIndex).toBe(1);
    expect(events.some((e) => e.type === "probe_skipped_time")).toBe(true);

    const final = await engine.onCandidateAnswer("Sama seperti tadi.");
    expect(engine.state.phase).toBe("CANDIDATE_QUESTIONS"); // both competencies covered
    expect(final.utterance).toContain("ada yang mau kamu tanyakan");
  });
});

describe("InterviewEngine: interruption & resume", () => {
  it("round-trips state through the store and resumes at the last incomplete competency", async () => {
    const kv = new MemoryKvStore();
    const rules: [RegExp, string][] = [
      [/pertanyaan pembuka.*Komunikasi/is, "Pertanyaan komunikasi?"],
      [/Analisis jawaban/i, STAR_COMPLETE],
    ];
    const engine = new InterviewEngine(fixtureConfig(), testLlm(rules));
    engine.begin();
    await engine.onCandidateAnswer("Siap");
    await saveState(kv, engine.state);

    // ...connection drops; candidate rejoins within the window...
    const restored = await loadState(kv, "int-test");
    expect(restored).not.toBeNull();
    const resumed = new InterviewEngine(fixtureConfig(), testLlm(rules), {
      state: restored as EngineState,
    });
    const greeting = resumed.resumeGreeting();
    expect(greeting.utterance).toContain("Selamat datang kembali");
    expect(greeting.utterance).toContain("Pertanyaan komunikasi?"); // repeats pending question
    expect(resumed.state.competencyIndex).toBe(0);
    expect(resumed.state.turns.length).toBeGreaterThan(2);
  });

  it("expires abandoned sessions after the resume window", async () => {
    let now = 0;
    const kv = new MemoryKvStore(() => now);
    const engine = new InterviewEngine(fixtureConfig(), testLlm(DEFAULT_RULES));
    engine.begin();
    await saveState(kv, engine.state);

    now = 16 * 60_000; // 16 minutes later
    expect(await loadState(kv, "int-test")).toBeNull();
  });
});

describe("InterviewEngine: LLM failure degradation", () => {
  it("falls back to template questions when the LLM errors", async () => {
    const failing: LlmProvider = {
      complete: async () => {
        throw new Error("provider down");
      },
      // biome-ignore lint/correctness/useYield: mock fails before producing anything
      stream: async function* () {
        throw new Error("provider down");
      },
    };
    const events: EngineEvent[] = [];
    const engine = new InterviewEngine(fixtureConfig(), failing, {
      onEvent: (e) => events.push(e),
    });
    engine.begin();
    const q = await engine.onCandidateAnswer("Siap");
    expect(q.utterance).toContain("komunikasi"); // deterministic fallback template
    expect(events.some((e) => e.type === "llm_fallback")).toBe(true);
  });
});
