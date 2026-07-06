import type { LlmProvider } from "@selia/voice-core";
import { checkUtterance } from "./guardrails.js";
import { Planner } from "./planner.js";
import {
  CANDIDATE_QUESTIONS_TRANSITION,
  CLOSING_SCRIPT,
  fallbackCoreQuestion,
  fallbackProbe,
  OFF_TOPIC_REDIRECT,
  openingScript,
  PROMPT_VERSION,
  RESUME_SCRIPT,
} from "./prompts/v1.js";
import type {
  CompetencySpec,
  EngineConfig,
  EngineEvent,
  EngineState,
  TranscriptTurn,
  TurnType,
} from "./types.js";

const NO_QUESTION_PATTERN = /\b(tidak|nggak|ga(k)? ada|belum ada|cukup|no|nothing)\b/i;
/**
 * Interrogative cues. Indonesian questions routinely embed negation words
 * ("ada bonusnya nggak?", "remote atau tidak?") — NO_QUESTION alone read those
 * as "no more questions" and hung up on the candidate mid-conversation.
 */
const QUESTION_CUE =
  /\?|\b(apa(kah)?|bagaimana|gimana|berapa|kapan|kenapa|mengapa|siapa|di\s?mana|dimana|boleh|bisa|adakah)\b/i;

export interface EngineReply {
  utterance: string;
  done: boolean;
}

/**
 * Hybrid structured-dynamic interview state machine:
 * OPENING → per competency (ordered): CORE_QUESTION → PROBE_LOOP(0..N) →
 * CANDIDATE_QUESTIONS → CLOSING.
 *
 * The competency list and rubric are fixed per job (comparability); only the
 * probing path is personalized from CV + live answers. Every AI utterance
 * passes the deterministic guardrail layer before being returned.
 */
export class InterviewEngine {
  readonly config: EngineConfig;
  private st: EngineState;
  private planner: Planner;
  private clock: () => number;
  private onEvent: (e: EngineEvent) => void;

  constructor(
    config: EngineConfig,
    llm: LlmProvider,
    opts?: {
      state?: EngineState;
      clock?: () => number;
      onEvent?: (e: EngineEvent) => void;
    },
  ) {
    this.config = config;
    this.clock = opts?.clock ?? Date.now;
    this.onEvent = opts?.onEvent ?? (() => {});
    this.planner = new Planner(llm, config, this.onEvent);
    this.st = opts?.state ?? {
      interviewId: config.interviewId,
      promptVersion: PROMPT_VERSION,
      phase: "OPENING",
      competencyIndex: 0,
      probesUsed: 0,
      candidateQuestionsAnswered: 0,
      lastQuestion: null,
      startedAtMs: this.clock(),
      lastActiveAtMs: this.clock(),
      turns: [],
    };
  }

  /** Serializable snapshot — persist after every turn. */
  get state(): EngineState {
    return this.st;
  }

  private get competency(): CompetencySpec {
    const c = this.config.competencies[this.st.competencyIndex];
    if (!c) throw new Error(`no competency at index ${this.st.competencyIndex}`);
    return c;
  }

  private record(speaker: "AI" | "CANDIDATE", text: string, turnType: TurnType): void {
    const turn: TranscriptTurn = {
      seq: this.st.turns.length,
      speaker,
      text,
      turnType,
      competencyId: this.st.phase === "COMPETENCY" ? this.competencyIdSafe() : null,
      ts: Math.round((this.clock() - this.st.startedAtMs) / 100) / 10,
    };
    this.st.turns.push(turn);
    this.st.lastActiveAtMs = this.clock();
  }

  private competencyIdSafe(): string | null {
    return this.config.competencies[this.st.competencyIndex]?.id ?? null;
  }

  /** Guardrail-check an AI utterance; on violation swap in the fallback and audit. */
  private guard(text: string, fallback: string): string {
    const result = checkUtterance(text, fallback);
    if (!result.ok) {
      this.onEvent({
        type: "guardrail_blocked",
        detail: { topic: result.topic, original: result.original, replaced: result.text },
      });
    }
    return result.text;
  }

  /** First AI utterance of a fresh interview. */
  begin(): EngineReply {
    if (this.st.phase !== "OPENING" || this.st.turns.length > 0) {
      throw new Error("begin() is only valid on a fresh session");
    }
    const utterance = openingScript(
      this.config.candidateName,
      this.config.jobTitle,
      this.config.competencies.length,
      this.config.targetDurationMin,
    );
    this.record("AI", utterance, "OPENING");
    // first core question generates while the greeting plays — the first real
    // turn then needs zero LLM calls before speaking
    const first = this.config.competencies[0];
    if (first) this.planner.prefetchCoreQuestion(first);
    return { utterance, done: false };
  }

  /** Greeting after an interruption: re-anchor at the last incomplete competency. */
  resumeGreeting(): EngineReply {
    this.onEvent({
      type: "resumed",
      detail: { phase: this.st.phase, competencyIndex: this.st.competencyIndex },
    });
    const question =
      this.st.lastQuestion ??
      (this.st.phase === "COMPETENCY" ? fallbackCoreQuestion(this.competency) : "");
    const utterance = question ? `${RESUME_SCRIPT} ${question}` : RESUME_SCRIPT;
    this.record("AI", utterance, "CLARIFY");
    return { utterance, done: false };
  }

  /**
   * Probes allowed for the current competency given the remaining time.
   * Always covers every competency; probing depth is what flexes.
   */
  private probesAllowedNow(): number {
    const totalMs = this.config.targetDurationMin * 60_000;
    const elapsed = this.clock() - this.st.startedAtMs;
    const remaining = totalMs - elapsed;
    const remainingComps = Math.max(this.config.competencies.length - this.st.competencyIndex, 1);
    const reserveMs = 2 * 60_000; // candidate questions + closing
    const perCompetencyMs = (remaining - reserveMs) / remainingComps;
    if (perCompetencyMs >= 150_000) return this.config.maxProbesPerCompetency;
    if (perCompetencyMs >= 75_000) return Math.min(1, this.config.maxProbesPerCompetency);
    return 0;
  }

  private behindSchedule(): boolean {
    return this.probesAllowedNow() < this.config.maxProbesPerCompetency;
  }

  async onCandidateAnswer(answer: string): Promise<EngineReply> {
    switch (this.st.phase) {
      case "OPENING": {
        this.record("CANDIDATE", answer, "OPENING");
        this.st.phase = "COMPETENCY";
        return this.askCoreQuestion(false);
      }
      case "COMPETENCY": {
        this.record("CANDIDATE", answer, this.st.probesUsed > 0 ? "PROBE" : "CORE_QUESTION");
        return this.handleCompetencyAnswer(answer);
      }
      case "CANDIDATE_QUESTIONS": {
        this.record("CANDIDATE", answer, "CLOSING");
        return this.handleCandidateQuestion(answer);
      }
      default: {
        return { utterance: CLOSING_SCRIPT, done: true };
      }
    }
  }

  private async askCoreQuestion(withTransition: boolean): Promise<EngineReply> {
    const competency = this.competency;
    const generated = await this.planner.coreQuestion(competency);
    let utterance = this.guard(generated, fallbackCoreQuestion(competency));
    if (withTransition && !this.behindSchedule()) {
      utterance = `Oke, terima kasih. ${utterance}`;
    }
    this.st.lastQuestion = utterance;
    this.record("AI", utterance, "CORE_QUESTION");
    // while the candidate answers this one, pre-generate the next competency's
    // question — the transition turn then costs one LLM call (analyze), not two
    const next = this.config.competencies[this.st.competencyIndex + 1];
    if (next) this.planner.prefetchCoreQuestion(next);
    return { utterance, done: false };
  }

  private async handleCompetencyAnswer(answer: string): Promise<EngineReply> {
    const competency = this.competency;
    const analysis = await this.planner.analyzeAnswer(
      competency,
      this.st.lastQuestion ?? "",
      answer,
    );

    if (analysis.offTopic) {
      // Redirect counts against the probe budget so a rambling candidate can't loop forever.
      this.st.probesUsed++;
      const utterance = `${OFF_TOPIC_REDIRECT} ${this.st.lastQuestion ?? ""}`.trim();
      this.record("AI", utterance, "CLARIFY");
      return { utterance, done: false };
    }

    const probesAllowed = Math.min(this.config.maxProbesPerCompetency, this.probesAllowedNow());
    if (analysis.missing.length > 0 && this.st.probesUsed < probesAllowed) {
      const firstMissing = analysis.missing[0] ?? "result";
      const probeText = analysis.followUp.trim() || fallbackProbe(firstMissing);
      const utterance = this.guard(probeText, fallbackProbe(firstMissing));
      this.st.probesUsed++;
      this.st.lastQuestion = utterance;
      this.record("AI", utterance, "PROBE");
      return { utterance, done: false };
    }

    if (analysis.missing.length > 0 && this.st.probesUsed >= probesAllowed) {
      this.onEvent({
        type: "probe_skipped_time",
        detail: { competency: competency.id, missing: analysis.missing },
      });
    }

    // Advance to the next competency or to candidate questions.
    this.st.competencyIndex++;
    this.st.probesUsed = 0;
    if (this.st.competencyIndex < this.config.competencies.length) {
      return this.askCoreQuestion(true);
    }
    this.st.phase = "CANDIDATE_QUESTIONS";
    this.st.lastQuestion = CANDIDATE_QUESTIONS_TRANSITION;
    this.record("AI", CANDIDATE_QUESTIONS_TRANSITION, "CLOSING");
    return { utterance: CANDIDATE_QUESTIONS_TRANSITION, done: false };
  }

  private async handleCandidateQuestion(answer: string): Promise<EngineReply> {
    const noQuestion =
      NO_QUESTION_PATTERN.test(answer) && answer.length < 60 && !QUESTION_CUE.test(answer);
    if (noQuestion || this.st.candidateQuestionsAnswered >= 2) {
      return this.close();
    }
    const reply = await this.planner.answerCandidateQuestion(answer);
    const safe = this.guard(reply, "Detail itu nanti bisa kamu tanyakan ke tim rekruter ya.");
    this.st.candidateQuestionsAnswered++;
    const utterance = `${safe} Ada lagi yang mau kamu tanyakan?`;
    this.record("AI", utterance, "CLOSING");
    return { utterance, done: false };
  }

  private close(): EngineReply {
    this.st.phase = "DONE";
    this.record("AI", CLOSING_SCRIPT, "CLOSING");
    return { utterance: CLOSING_SCRIPT, done: true };
  }
}
