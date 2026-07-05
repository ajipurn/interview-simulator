/** Per-turn latency marks, all relative to end-of-utterance (candidate stopped speaking). */
export interface TurnLatency {
  turn: number;
  /** end of utterance → first LLM token (TTFT); -1 if the turn was aborted before it */
  eouToLlmFirstMs: number;
  /** end of utterance → first AI audio byte incl. fillers — THE product metric (p50 < 1500, p95 < 3000) */
  eouToFirstAudioMs: number;
  /** end of utterance → first synthesized *reply* audio (fillers excluded) */
  eouToContentAudioMs: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

function stats(values: number[]) {
  const sorted = values.filter((v) => v >= 0).sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
}

export class LatencyRecorder {
  private turns: TurnLatency[] = [];
  private counter = 0;

  /** Returns a recorder for one conversational turn. Marks are idempotent; end() persists. */
  startTurn() {
    const turn = ++this.counter;
    const eou = performance.now();
    let llmFirst = -1;
    let audioFirst = -1;
    let contentFirst = -1;
    let ended = false;
    const self = this;

    return {
      markLlmFirstToken() {
        if (llmFirst < 0) llmFirst = performance.now() - eou;
      },
      /** Any audio reaching the candidate, fillers included. */
      markFirstAudio() {
        if (audioFirst < 0) audioFirst = performance.now() - eou;
      },
      /** First synthesized chunk of the actual reply. */
      markContentAudio() {
        if (contentFirst < 0) contentFirst = performance.now() - eou;
      },
      end() {
        if (ended) return;
        ended = true;
        if (audioFirst < 0 && llmFirst < 0) return; // barge-in before anything happened
        const record: TurnLatency = {
          turn,
          eouToLlmFirstMs: Math.round(llmFirst),
          eouToFirstAudioMs: Math.round(audioFirst),
          eouToContentAudioMs: Math.round(contentFirst),
        };
        self.turns.push(record);
        console.log(JSON.stringify({ evt: "turn_latency", ...record }));
      },
    };
  }

  /** Aggregate view served at /metrics. */
  summary() {
    return {
      turns: this.turns.length,
      eouToFirstAudioMs: {
        ...stats(this.turns.map((t) => t.eouToFirstAudioMs)),
        budget: { p50: 1500, p95: 3000 },
      },
      eouToContentAudioMs: stats(this.turns.map((t) => t.eouToContentAudioMs)),
      eouToLlmFirstMs: stats(this.turns.map((t) => t.eouToLlmFirstMs)),
      recent: this.turns.slice(-20),
    };
  }
}
