import { ScoringOutput } from "@selia/shared";
import type { LlmMessage, LlmProvider } from "@selia/voice-core";
import { describe, expect, it } from "vitest";
import {
  feedbackLeaks,
  generateCandidateFeedback,
  overallScore,
  type ScoringInput,
  scoreInterview,
} from "./scoring.js";
import type { CompetencySpec } from "./types.js";

function llmReturning(...responses: string[]): LlmProvider {
  let i = 0;
  const next = () => responses[Math.min(i++, responses.length - 1)] ?? "";
  return {
    complete: async (_m: LlmMessage[]) => next(),
    stream: async function* () {
      yield next();
    },
  };
}

const COMPETENCIES: CompetencySpec[] = [
  { id: "c1", name: "Komunikasi", description: "d", weight: 2, order: 0, rubricLevels: [] },
  { id: "c2", name: "Penanganan Masalah", description: "d", weight: 1, order: 1, rubricLevels: [] },
];

function validScoring(scores: [number, number] = [4, 3]): string {
  return JSON.stringify({
    competencyScores: [
      {
        competencyId: "c1",
        score: scores[0],
        justification: "Contoh konkret dengan hasil terukur.",
        evidenceQuotes: [{ turnSeq: 2, quote: "saya konfirmasi ulang ke pelanggan" }],
      },
      {
        competencyId: "c2",
        score: scores[1],
        justification: "Aksi jelas, hasil kurang terukur.",
        evidenceQuotes: [{ turnSeq: 4, quote: "komplain selesai dan pelanggan lanjut" }],
      },
    ],
    summary: "Satu. Dua. Tiga. Empat. Lima.",
    redFlags: [],
    recommendation: "ADVANCE",
  });
}

// 5 fixture transcripts — varying length, code-switching, terse and rambling answers.
const FIXTURE_TRANSCRIPTS: ScoringInput["turns"][] = [
  [
    { seq: 0, speaker: "AI", text: "Halo, ceritakan pengalamanmu." },
    { seq: 1, speaker: "CANDIDATE", text: "Saya dua tahun di customer service ritel." },
  ],
  [
    { seq: 0, speaker: "AI", text: "Gimana kamu menangani komplain besar?" },
    { seq: 1, speaker: "CANDIDATE", text: "Saya listen dulu, terus saya follow up sampai closed." },
    { seq: 2, speaker: "AI", text: "Hasilnya?" },
    { seq: 3, speaker: "CANDIDATE", text: "CSAT naik dari 4.1 ke 4.6 dalam tiga bulan." },
  ],
  [
    { seq: 0, speaker: "AI", text: "Ceritakan targetmu." },
    { seq: 1, speaker: "CANDIDATE", text: "Hmm apa ya... pokoknya kerja aja sih." },
  ],
  [
    { seq: 0, speaker: "AI", text: "Peranmu di proyek itu apa?" },
    {
      seq: 1,
      speaker: "CANDIDATE",
      text: "Saya lead squad kecil, handle eskalasi, dan bikin SOP baru untuk tim malam.",
    },
  ],
  [
    { seq: 0, speaker: "AI", text: "Kenapa pindah industri?" },
    { seq: 1, speaker: "CANDIDATE", text: "Cari tantangan baru, dan skill CS saya transferable." },
    { seq: 2, speaker: "AI", text: "Contohnya?" },
    { seq: 3, speaker: "CANDIDATE", text: "Empati dan de-eskalasi konflik kepakai di mana-mana." },
  ],
];

describe("scoreInterview", () => {
  it.each(
    FIXTURE_TRANSCRIPTS.map((t, i) => [i, t] as const),
  )("produces schema-valid scoring for fixture transcript %i", async (_i, turns) => {
    const result = await scoreInterview(llmReturning(validScoring()), {
      jobTitle: "CS Officer",
      competencies: COMPETENCIES,
      turns,
    });
    expect(ScoringOutput.parse(result)).toBeTruthy();
    expect(result.competencyScores).toHaveLength(2);
    expect(result.competencyScores.every((s) => s.evidenceQuotes.length >= 1)).toBe(true);
  });

  it("retries on malformed JSON, then succeeds", async () => {
    const result = await scoreInterview(llmReturning("maaf, ini bukan JSON", validScoring()), {
      jobTitle: "CS",
      competencies: COMPETENCIES,
      turns: FIXTURE_TRANSCRIPTS[0] ?? [],
    });
    expect(result.recommendation).toBe("ADVANCE");
  });

  it("rejects scoring that misses a rubric competency", async () => {
    const partial = JSON.stringify({
      competencyScores: [
        {
          competencyId: "c1",
          score: 4,
          justification: "x",
          evidenceQuotes: [{ turnSeq: 1, quote: "q" }],
        },
      ],
      summary: "s",
      redFlags: [],
      recommendation: "CONSIDER",
    });
    await expect(
      scoreInterview(llmReturning(partial, partial, partial), {
        jobTitle: "CS",
        competencies: COMPETENCIES,
        turns: FIXTURE_TRANSCRIPTS[0] ?? [],
      }),
    ).rejects.toThrow(/scoring failed/);
  });
});

describe("overallScore", () => {
  it("weights competencies", () => {
    // c1 weight 2 score 4, c2 weight 1 score 1 → (8+1)/3 = 3
    expect(
      overallScore(
        [
          { competencyId: "c1", score: 4 },
          { competencyId: "c2", score: 1 },
        ],
        COMPETENCIES,
      ),
    ).toBe(3);
  });
});

describe("candidate feedback safety", () => {
  const LEAKY = JSON.stringify({
    strengths: ["Kamu dapat skor 4 dari 5 untuk komunikasi.", "Jawabanmu runtut."],
    growthAreas: ["Kurang detail."],
    tips: "Selamat, kamu lolos ke tahap berikutnya!",
  });
  const SAFE = JSON.stringify({
    strengths: ["Ceritamu runtut dan mudah diikuti.", "Kamu kooperatif sepanjang sesi."],
    growthAreas: ["Tambahkan dampak konkret dari kerjamu."],
    tips: "Pakai pola situasi-tugas-aksi-hasil saat bercerita.",
  });

  it("feedbackLeaks catches scores and decisions", () => {
    expect(feedbackLeaks(JSON.parse(LEAKY))).toBe(true);
    expect(feedbackLeaks(JSON.parse(SAFE))).toBe(false);
  });

  it("regenerates leaky feedback and never returns scores/decisions", async () => {
    const result = await generateCandidateFeedback(llmReturning(LEAKY, SAFE), {
      jobTitle: "CS",
      turns: FIXTURE_TRANSCRIPTS[1] ?? [],
    });
    expect(feedbackLeaks(result)).toBe(false);
  });

  it("falls back to safe template when the LLM keeps leaking", async () => {
    const result = await generateCandidateFeedback(llmReturning(LEAKY, LEAKY, LEAKY), {
      jobTitle: "CS",
      turns: FIXTURE_TRANSCRIPTS[1] ?? [],
    });
    expect(feedbackLeaks(result)).toBe(false);
    expect(result.strengths.length).toBeGreaterThanOrEqual(2);
  });
});
