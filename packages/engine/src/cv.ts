import { CvProfile, z } from "@selia/shared";
import type { LlmProvider } from "@selia/voice-core";
import { shield } from "./guardrails.js";
import { cvParsePrompt } from "./prompts/v1.js";
import { extractJson } from "./scoring.js";

const MAX_ATTEMPTS = 3;

export const CvParseOutput = z.object({
  profile: CvProfile,
  confidence: z.number().min(0).max(1),
  // identity pulled from the CV header — lets bulk upload create candidates without manual entry
  contact: z
    .object({
      name: z.string().default(""),
      email: z.string().optional(),
      phone: z.string().optional(),
    })
    .default({ name: "" }),
});
export type CvParseOutput = z.infer<typeof CvParseOutput>;

/**
 * Raw CV text → structured CvProfile + confidence, zod-validated and retried
 * on schema failure. Throws after MAX_ATTEMPTS — caller decides whether a
 * candidate without a parsed CV is acceptable (interview falls back to JD).
 */
export async function parseCv(llm: LlmProvider, rawText: string): Promise<CvParseOutput> {
  const prompt = cvParsePrompt({ rawTextShielded: shield(rawText, 16_000) });
  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await llm.complete([{ role: "user", content: prompt }], {
        temperature: 0.2,
        maxTokens: 2000,
      });
      const parsed = CvParseOutput.safeParse(extractJson(raw));
      if (!parsed.success) {
        lastError = parsed.error.message;
        continue;
      }
      return parsed.data;
    } catch (err) {
      lastError = String(err);
    }
  }
  throw new Error(`cv parsing failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}
