import type { CvProfile } from "@selia/shared";
import type { LlmProvider } from "@selia/voice-core";
import { shield } from "./guardrails.js";
import {
  candidateQuestionPrompt,
  coreQuestionPrompt,
  fallbackCoreQuestion,
  starAnalysisPrompt,
} from "./prompts/v1.js";
import { type CompetencySpec, type EngineConfig, type EngineEvent, StarAnalysis } from "./types.js";

/** Flatten a parsed CV into shielded plain text for prompt injection. */
export function cvProfileText(cv: CvProfile): string {
  const lines = [
    cv.summary,
    ...cv.experiences.map(
      (e) =>
        `- ${e.role} di ${e.company}${e.highlights.length ? `: ${e.highlights.join("; ")}` : ""}`,
    ),
    ...cv.education.map((e) => `- Pendidikan: ${e.degree ?? ""} ${e.institution}`),
    cv.skills.length ? `Skill: ${cv.skills.join(", ")}` : "",
    cv.probingPoints.length ? `Poin menarik untuk digali: ${cv.probingPoints.join("; ")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function extractJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no JSON object in LLM output");
  return JSON.parse(match[0]);
}

/**
 * LLM-backed question planning. Every method degrades to a deterministic
 * template on LLM failure — the interview never stalls on a provider error.
 */
export class Planner {
  constructor(
    private llm: LlmProvider,
    private cfg: EngineConfig,
    private onEvent: (e: EngineEvent) => void = () => {},
  ) {}

  /** Core question for a competency: CV-personalized when material exists, JD-based otherwise. */
  async coreQuestion(competency: CompetencySpec): Promise<string> {
    const prompt = coreQuestionPrompt({
      jobTitle: this.cfg.jobTitle,
      competency,
      cvProfileShielded: this.cfg.cvProfile ? shield(cvProfileText(this.cfg.cvProfile)) : null,
      jdTextShielded: shield(this.cfg.jdText),
    });
    try {
      const q = (
        await this.llm.complete([{ role: "user", content: prompt }], {
          temperature: 0.4,
          maxTokens: 300,
        })
      ).trim();
      if (!q) throw new Error("empty core question");
      return q;
    } catch (err) {
      this.onEvent({
        type: "llm_fallback",
        detail: { where: "coreQuestion", competency: competency.id, err: String(err) },
      });
      return fallbackCoreQuestion(competency);
    }
  }

  /** STAR-gap analysis of an answer; drives the probe decision. */
  async analyzeAnswer(
    competency: CompetencySpec,
    question: string,
    answer: string,
  ): Promise<StarAnalysis> {
    const prompt = starAnalysisPrompt({
      competency,
      question,
      answerShielded: shield(answer),
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await this.llm.complete([{ role: "user", content: prompt }], {
          temperature: 0.2,
          maxTokens: 300,
        });
        const parsed = StarAnalysis.safeParse(extractJson(raw));
        if (parsed.success) return parsed.data;
      } catch {
        // fall through to retry / fallback
      }
    }
    this.onEvent({
      type: "llm_fallback",
      detail: { where: "analyzeAnswer", competency: competency.id },
    });
    // Safe default: treat the answer as sufficient and move on.
    return { offTopic: false, missing: [], followUp: "" };
  }

  async answerCandidateQuestion(question: string): Promise<string> {
    const prompt = candidateQuestionPrompt({
      jobTitle: this.cfg.jobTitle,
      questionShielded: shield(question),
    });
    try {
      const a = (
        await this.llm.complete([{ role: "user", content: prompt }], {
          temperature: 0.4,
          maxTokens: 200,
        })
      ).trim();
      if (!a) throw new Error("empty answer");
      return a;
    } catch {
      return "Pertanyaan bagus. Detail itu nanti bisa kamu tanyakan langsung ke tim rekruter ya, mereka yang paling tepat menjawabnya.";
    }
  }
}
