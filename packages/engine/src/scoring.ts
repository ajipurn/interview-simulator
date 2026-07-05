import { CandidateFeedbackOutput, ScoringOutput } from "@selia/shared";
import type { LlmProvider } from "@selia/voice-core";
import { shield } from "./guardrails.js";
import { candidateFeedbackPrompt, scoringPrompt } from "./prompts/v1.js";
import type { CompetencySpec, TranscriptTurn } from "./types.js";

const MAX_ATTEMPTS = 3;

export interface ScoringInput {
  jobTitle: string;
  competencies: CompetencySpec[];
  turns: Pick<TranscriptTurn, "seq" | "speaker" | "text">[];
}

export function transcriptText(turns: ScoringInput["turns"]): string {
  return turns
    .map((t) => `[${t.seq}] ${t.speaker === "AI" ? "SELIA" : "KANDIDAT"}: ${t.text}`)
    .join("\n");
}

export function extractJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no JSON in LLM output");
  return JSON.parse(match[0]);
}

/** Weighted overall score, computed in code — never trusted to the LLM. */
export function overallScore(
  scores: { competencyId: string; score: number }[],
  competencies: CompetencySpec[],
): number {
  let sum = 0;
  let weightSum = 0;
  for (const s of scores) {
    const weight = competencies.find((c) => c.id === s.competencyId)?.weight ?? 1;
    sum += s.score * weight;
    weightSum += weight;
  }
  return weightSum === 0 ? 0 : Math.round((sum / weightSum) * 100) / 100;
}

/**
 * Evidence-based scoring: transcript + rubric → per-competency scores with
 * verbatim quotes. Deterministic-ish (temperature 0.2), zod-validated, retried
 * on schema failure. Throws after MAX_ATTEMPTS — the worker keeps the job failed
 * rather than persisting garbage.
 */
export async function scoreInterview(
  llm: LlmProvider,
  input: ScoringInput,
): Promise<ScoringOutput> {
  const prompt = scoringPrompt({
    jobTitle: input.jobTitle,
    competencies: input.competencies,
    transcriptShielded: shield(transcriptText(input.turns), 24_000),
  });
  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await llm.complete([{ role: "user", content: prompt }], {
        temperature: 0.2,
        maxTokens: 3000,
      });
      const parsed = ScoringOutput.safeParse(extractJson(raw));
      if (!parsed.success) {
        lastError = parsed.error.message;
        continue;
      }
      // every rubric competency must be scored — partial scoring breaks comparability
      const scoredIds = new Set(parsed.data.competencyScores.map((s) => s.competencyId));
      if (!input.competencies.every((c) => scoredIds.has(c.id))) {
        lastError = "missing competency scores";
        continue;
      }
      return parsed.data;
    } catch (err) {
      lastError = String(err);
    }
  }
  throw new Error(`scoring failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}

// Feedback must never leak assessment outcomes — deterministic floor, same idea
// as the conversation guardrails.
const FEEDBACK_LEAK =
  /\b(skor|score|nilai \d|\d ?\/ ?5|diterima|ditolak|tidak lolos|lolos|direkomendasikan|hired|rejected|passed|failed)\b/i;

export function feedbackLeaks(fb: CandidateFeedbackOutput): boolean {
  const all = [...fb.strengths, ...fb.growthAreas, fb.tips].join(" ");
  return FEEDBACK_LEAK.test(all);
}

const FALLBACK_FEEDBACK: CandidateFeedbackOutput = {
  strengths: [
    "Kamu menyelesaikan seluruh sesi wawancara dengan baik.",
    "Kamu menjawab setiap pertanyaan dengan sopan dan kooperatif.",
  ],
  growthAreas: ["Coba sertakan contoh yang lebih spesifik dengan hasil yang terukur."],
  tips: "Saat menjawab, gunakan pola situasi-tugas-aksi-hasil supaya ceritamu utuh dan mudah diikuti.",
};

/** Supportive candidate feedback; never contains scores or hiring decisions. */
export async function generateCandidateFeedback(
  llm: LlmProvider,
  input: Pick<ScoringInput, "jobTitle" | "turns">,
): Promise<CandidateFeedbackOutput> {
  const prompt = candidateFeedbackPrompt({
    jobTitle: input.jobTitle,
    transcriptShielded: shield(transcriptText(input.turns), 24_000),
  });
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await llm.complete([{ role: "user", content: prompt }], {
        temperature: 0.3,
        maxTokens: 800,
      });
      const parsed = CandidateFeedbackOutput.safeParse(extractJson(raw));
      if (parsed.success && !feedbackLeaks(parsed.data)) return parsed.data;
    } catch {
      // retry
    }
  }
  return FALLBACK_FEEDBACK;
}
