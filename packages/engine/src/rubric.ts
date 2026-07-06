import { type CompetencyInput, GeneratedRubric } from "@selia/shared";
import type { LlmProvider } from "@selia/voice-core";
import { shield } from "./guardrails.js";
import { rubricPrompt } from "./prompts/v1.js";
import { extractJson } from "./scoring.js";

const MAX_ATTEMPTS = 3;

/**
 * JD → 3-5 competencies with 5-level rubrics, zod-validated and retried on
 * schema failure. Throws after MAX_ATTEMPTS — the route returns an error
 * rather than persisting a garbage rubric (recruiter just retries).
 * `jobSafe: false` = the title itself is offensive/explicit/illegal; the
 * caller should refuse the session instead of interviewing around it.
 */
export async function generateRubric(
  llm: LlmProvider,
  input: { jobTitle: string; jdText: string },
): Promise<{ competencies: CompetencyInput[]; jobSafe: boolean }> {
  const prompt = rubricPrompt({
    jobTitle: shield(input.jobTitle, 80),
    jdTextShielded: shield(input.jdText, 12_000),
  });
  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await llm.complete([{ role: "user", content: prompt }], {
        temperature: 0.3,
        maxTokens: 2000,
      });
      const parsed = GeneratedRubric.safeParse(extractJson(raw));
      if (!parsed.success) {
        lastError = parsed.error.message;
        continue;
      }
      return { competencies: parsed.data.competencies, jobSafe: parsed.data.jobSafe };
    } catch (err) {
      lastError = String(err);
    }
  }
  throw new Error(`rubric generation failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}
