import { z } from "zod";

export { z };

// --- Jobs & rubric (JD → generated rubric, editable while DRAFT) ---
export const RubricLevelInput = z.object({
  level: z.number().int().min(1).max(5),
  descriptor: z.string().min(1),
});

export const CompetencyInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(300),
  weight: z.number().positive().max(5).default(1),
  rubricLevels: z.array(RubricLevelInput).length(5),
});
export type CompetencyInput = z.infer<typeof CompetencyInput>;

export const CreateJobInput = z.object({
  title: z.string().min(3).max(120),
  jdText: z.string().min(30).max(20_000),
  targetDurationMin: z.number().int().min(5).max(60).default(15),
});
export type CreateJobInput = z.infer<typeof CreateJobInput>;

export const UpdateJobInput = z.object({
  status: z.enum(["DRAFT", "ACTIVE", "CLOSED"]).optional(),
  competencies: z.array(CompetencyInput).min(2).max(6).optional(),
});
export type UpdateJobInput = z.infer<typeof UpdateJobInput>;

/** LLM structured output for rubric generation; order comes from array position. */
export const GeneratedRubric = z.object({
  competencies: z.array(CompetencyInput).min(3).max(5),
});
export type GeneratedRubric = z.infer<typeof GeneratedRubric>;

// --- Organization & members ---
export const MemberRole = z.enum(["ADMIN", "RECRUITER", "VIEWER"]);
export type MemberRole = z.infer<typeof MemberRole>;

export const InviteMemberInput = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  role: MemberRole.default("RECRUITER"),
});
export type InviteMemberInput = z.infer<typeof InviteMemberInput>;

export const UpdateMemberInput = z.object({ role: MemberRole });
export type UpdateMemberInput = z.infer<typeof UpdateMemberInput>;

export const UpdateOrgInput = z.object({
  name: z.string().min(1).max(120).optional(),
});
export type UpdateOrgInput = z.infer<typeof UpdateOrgInput>;

// --- Candidates (manual entry; bulk CV upload is a later phase) ---
export const AddCandidatesInput = z.object({
  candidates: z
    .array(
      z
        .object({
          name: z.string().min(1).max(120),
          phoneWa: z
            .string()
            .regex(/^\+?[0-9]{8,15}$/, "nomor WA tidak valid")
            .optional(),
          email: z.string().email().optional(),
        })
        .refine((c) => c.phoneWa || c.email, { message: "butuh WA atau email" }),
    )
    .min(1)
    .max(50),
  windowDays: z.number().int().min(1).max(30).default(3),
});
export type AddCandidatesInput = z.infer<typeof AddCandidatesInput>;

export const SendInvitationsInput = z.object({
  interviewIds: z.array(z.string().min(1)).min(1).max(100).optional(),
});
export type SendInvitationsInput = z.infer<typeof SendInvitationsInput>;

// --- Parsed CV profile (output of CV parsing, input to question planner) ---
export const CvProfile = z.object({
  summary: z.string().default(""),
  experiences: z
    .array(
      z.object({
        company: z.string(),
        role: z.string(),
        start: z.string().optional(),
        end: z.string().optional(),
        highlights: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  education: z
    .array(z.object({ institution: z.string(), degree: z.string().optional() }))
    .default([]),
  skills: z.array(z.string()).default([]),
  projects: z.array(z.object({ name: z.string(), description: z.string().optional() })).default([]),
  probingPoints: z.array(z.string()).default([]), // career gaps, industry switches, bold claims
});
export type CvProfile = z.infer<typeof CvProfile>;

// --- Scoring output (LLM structured output, validated before persist) ---
export const EvidenceQuote = z.object({ turnSeq: z.number().int(), quote: z.string() });

export const ScoringOutput = z.object({
  competencyScores: z.array(
    z.object({
      competencyId: z.string(),
      score: z.number().int().min(1).max(5),
      justification: z.string(),
      evidenceQuotes: z.array(EvidenceQuote).min(1).max(3),
    }),
  ),
  summary: z.string(),
  redFlags: z.array(z.string()),
  recommendation: z.enum(["ADVANCE", "CONSIDER", "REJECT_SUGGESTED"]),
});
export type ScoringOutput = z.infer<typeof ScoringOutput>;

export const CandidateFeedbackOutput = z.object({
  strengths: z.array(z.string()).min(2).max(3),
  growthAreas: z.array(z.string()).min(1).max(2),
  tips: z.string(),
});
export type CandidateFeedbackOutput = z.infer<typeof CandidateFeedbackOutput>;
