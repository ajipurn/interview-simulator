import { type CvProfile, z } from "@selia/shared";

export interface RubricLevel {
  level: number;
  descriptor: string;
}

export interface CompetencySpec {
  id: string;
  name: string;
  description: string;
  weight: number;
  order: number;
  rubricLevels: RubricLevel[];
}

export interface EngineConfig {
  interviewId: string;
  jobTitle: string;
  jdText: string;
  candidateName: string;
  competencies: CompetencySpec[];
  cvProfile: CvProfile | null;
  targetDurationMin: number;
  maxProbesPerCompetency: number;
}

export type Phase = "OPENING" | "COMPETENCY" | "CANDIDATE_QUESTIONS" | "CLOSING" | "DONE";

export type TurnType = "OPENING" | "CORE_QUESTION" | "PROBE" | "CLARIFY" | "CLOSING";

export interface TranscriptTurn {
  seq: number;
  speaker: "AI" | "CANDIDATE";
  text: string;
  turnType: TurnType;
  competencyId: string | null;
  /** seconds since interview start — powers per-competency recording chapters */
  ts: number;
}

/** Serializable engine state — persisted to Redis after every turn for interruption recovery. */
export interface EngineState {
  interviewId: string;
  promptVersion: string;
  phase: Phase;
  competencyIndex: number;
  probesUsed: number;
  candidateQuestionsAnswered: number;
  /** last core question asked — repeated on resume */
  lastQuestion: string | null;
  startedAtMs: number;
  lastActiveAtMs: number;
  turns: TranscriptTurn[];
}

/** Emitted for auditability (guardrail triggers, prompt versions, plan decisions). */
export interface EngineEvent {
  type: "guardrail_blocked" | "probe_skipped_time" | "resumed" | "llm_fallback";
  detail: Record<string, unknown>;
}

/** LLM planner output for one candidate answer, zod-validated. */
export const StarAnalysis = z.object({
  offTopic: z.boolean().default(false),
  missing: z.array(z.enum(["situation", "task", "action", "result"])).default([]),
  /** targeted follow-up referencing the candidate's own words; required when probing */
  followUp: z.string().default(""),
});
export type StarAnalysis = z.infer<typeof StarAnalysis>;

/** Minimal KV abstraction so the store is testable without Redis. */
export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}
