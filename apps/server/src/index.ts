import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import {
  type CompetencySpec,
  type EngineConfig,
  generateCandidateFeedback,
  generateRubric,
  InterviewEngine,
  overallScore,
  scoreInterview,
} from "@selia/engine";
import { z } from "@selia/shared";
import { type AudioChunk, llmFromEnv, sttFromEnv, type TtsProvider, ttsFromEnv } from "@selia/voice-core";
import { type WebSocket, WebSocketServer } from "ws";
import { LatencyRecorder } from "./latency.js";
import { type AudioSink, VoicePipeline } from "./pipeline.js";

const PORT = Number(process.env.PORT ?? 4001);
/** The web client always resamples mic audio to this rate before sending. */
const CLIENT_SAMPLE_RATE = 16_000;

export interface GameReport {
  jobTitle: string;
  candidateName: string;
  overall: number;
  competencies: { name: string; score: number; justification: string }[];
  summary: string;
  strengths: string[];
  growthAreas: string[];
  tips: string;
}

interface GameSession {
  id: string;
  config: EngineConfig;
  status: "created" | "live" | "scoring" | "done";
  report: GameReport | null;
  createdAt: number;
}

const sessions = new Map<string, GameSession>();
// ponytail: one-shot in-memory sessions; sweep so a long-lived dev server doesn't leak
setInterval(
  () => {
    const cutoff = Date.now() - 60 * 60_000;
    for (const [id, s] of sessions) if (s.createdAt < cutoff) sessions.delete(id);
  },
  10 * 60_000,
).unref();

// --- budget guardrails ----------------------------------------------------
// Real providers bill per call/minute; a public-ish game with no auth needs
// server-side caps. Identity = client IP (good enough vs casual abuse).

/** Lifetime interview attempts per IP (an attempt = the WS interview actually starts). */
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 2);
/** Session creations per IP per day — every POST /session costs one rubric LLM call. */
const MAX_SESSIONS_PER_DAY = Number(process.env.MAX_SESSIONS_PER_DAY ?? 6);
/** Hard wall-clock cap per interview (STT streams per minute — the big leak). */
const INTERVIEW_MAX_MS = Number(process.env.INTERVIEW_MAX_MS ?? 12 * 60_000);
/** Mic open but nobody answering for this long → end the session. */
const IDLE_MAX_MS = Number(process.env.IDLE_MAX_MS ?? 3 * 60_000);

interface IpLimit {
  starts: number;
  day: string;
  createdToday: number;
}

// file-backed so a server restart doesn't hand everyone fresh attempts
const LIMITS_FILE = join(process.cwd(), "data", "limits.json");
const limits = new Map<string, IpLimit>();
try {
  for (const [ip, v] of Object.entries(
    JSON.parse(readFileSync(LIMITS_FILE, "utf8")) as Record<string, IpLimit>,
  ))
    limits.set(ip, v);
} catch {
  // first run — no file yet
}
function saveLimits(): void {
  try {
    mkdirSync(dirname(LIMITS_FILE), { recursive: true });
    writeFileSync(LIMITS_FILE, JSON.stringify(Object.fromEntries(limits)));
  } catch (err) {
    console.error(JSON.stringify({ evt: "limits_save_failed", err: String(err) }));
  }
}

const today = () => new Date().toISOString().slice(0, 10);

function limitFor(ip: string): IpLimit {
  let lim = limits.get(ip);
  if (!lim) {
    lim = { starts: 0, day: today(), createdToday: 0 };
    limits.set(ip, lim);
  }
  if (lim.day !== today()) {
    lim.day = today();
    lim.createdToday = 0;
  }
  return lim;
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

const ATTEMPTS_EXHAUSTED =
  "Jatah interview-mu sudah habis (maksimal 2 sesi per orang). Makasih sudah main!";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

const CreateSessionInput = z.object({
  jobTitle: z.string().trim().min(2).max(80),
  candidateName: z.string().trim().min(1).max(60),
});

async function createSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const lim = limitFor(clientIp(req));
  if (lim.starts >= MAX_ATTEMPTS) {
    sendJson(res, 429, { error: ATTEMPTS_EXHAUSTED });
    return;
  }
  if (lim.createdToday >= MAX_SESSIONS_PER_DAY) {
    sendJson(res, 429, { error: "Terlalu banyak percobaan hari ini — coba lagi besok ya." });
    return;
  }
  const parsed = CreateSessionInput.safeParse(await readBody(req));
  if (!parsed.success) {
    sendJson(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid input" });
    return;
  }
  lim.createdToday++;
  saveLimits();
  const { jobTitle, candidateName } = parsed.data;
  // player only types a position — synthesize a minimal JD for the rubric generator
  const jdText = `Posisi yang dilamar: ${jobTitle}. Wawancara kompetensi umum untuk peran ${jobTitle} di sebuah perusahaan di Indonesia.`;
  const rubric = await generateRubric(llmFromEnv(), { jobTitle, jdText });
  // 3 kompetensi cukup untuk satu ronde game (~8 menit)
  const competencies: CompetencySpec[] = rubric.slice(0, 3).map((c, i) => ({
    id: `c${i + 1}`,
    name: c.name,
    description: c.description,
    weight: c.weight,
    order: i,
    rubricLevels: c.rubricLevels,
  }));
  const id = randomUUID();
  sessions.set(id, {
    id,
    status: "created",
    report: null,
    createdAt: Date.now(),
    config: {
      interviewId: id,
      jobTitle,
      jdText,
      candidateName: candidateName.split(" ")[0] ?? candidateName,
      competencies,
      cvProfile: null,
      targetDurationMin: 8,
      maxProbesPerCompetency: 1,
    },
  });
  sendJson(res, 200, { sessionId: id, jobTitle, competencies: competencies.map((c) => c.name) });
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/session") return createSession(req, res);
    const report = url.pathname.match(/^\/session\/([\w-]+)\/report$/);
    if (req.method === "GET" && report) {
      const s = sessions.get(report[1] ?? "");
      if (!s) return sendJson(res, 404, { error: "unknown session" });
      if (!s.report) return sendJson(res, 425, { error: "not scored yet", status: s.status });
      return sendJson(res, 200, s.report);
    }
    if (url.pathname === "/health")
      return sendJson(res, 200, {
        ok: true,
        sessions: sessions.size,
        // which providers this process actually resolved — mock TTS sounds like a sine buzz
        providers: {
          stt: process.env.STT_PROVIDER ?? "mock",
          llm: process.env.LLM_PROVIDER ?? "mock",
          tts: process.env.TTS_PROVIDER ?? "mock",
        },
      });
    sendJson(res, 404, { error: "not found" });
  })().catch((err) => {
    console.error(JSON.stringify({ evt: "http_error", err: String(err) }));
    if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
  void runInterview(ws, req).catch((err) => {
    console.error(JSON.stringify({ evt: "session_error", err: String(err) }));
    ws.close(1011, "internal error");
  });
});

/**
 * Short acknowledgements the pipeline plays the instant a final transcript
 * arrives, masking LLM + TTS latency (2-5s of dead air otherwise). Synthesized
 * once per session, in the background — the greeting isn't delayed, and the
 * first candidate answer lands well after these resolve.
 */
const FILLER_LINES = ["Oke.", "Baik.", "Hmm, oke.", "Oke, menarik."];

function synthFillersInto(tts: TtsProvider, out: AudioChunk[][]): void {
  for (const line of FILLER_LINES) {
    void (async () => {
      const chunks: AudioChunk[] = [];
      for await (const c of tts.synthesize(line)) chunks.push(c);
      if (chunks.length > 0) out.push(chunks);
    })().catch((err) =>
      console.error(JSON.stringify({ evt: "filler_synth_failed", line, err: String(err) })),
    );
  }
}

/**
 * One live game interview over a WebSocket — the LiveKit-free counterpart of
 * selia's agent session: same engine, same pipeline, WS frames as transport.
 */
async function runInterview(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");
  const found = sessions.get(url.searchParams.get("session") ?? "");
  if (!found || found.status !== "created") {
    ws.close(4404, "unknown or already used session");
    return;
  }
  const session: GameSession = found;

  const send = (obj: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  // attempt is spent when the interview actually starts (mic on = billing on)
  const lim = limitFor(clientIp(req));
  if (lim.starts >= MAX_ATTEMPTS) {
    send({ type: "denied", reason: ATTEMPTS_EXHAUSTED });
    ws.close(4429, "attempts exhausted");
    return;
  }
  lim.starts++;
  saveLimits();

  session.status = "live";
  console.log(
    JSON.stringify({
      evt: "game_start",
      id: session.id,
      job: session.config.jobTitle,
      attempt: lim.starts,
    }),
  );
  const tts = ttsFromEnv();
  const sink: AudioSink = {
    write(chunk) {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(Buffer.from(chunk.pcm.buffer, chunk.pcm.byteOffset, chunk.pcm.byteLength));
    },
    clear() {
      send({ type: "clear" });
    },
  };

  const llm = llmFromEnv();
  const engine = new InterviewEngine(session.config, llm);
  const total = session.config.competencies.length;

  let finished = false;
  async function finalize(): Promise<void> {
    if (finished) return;
    finished = true;
    session.status = "scoring";
    send({ type: "scoring" });
    await pipeline.stop().catch(() => {});
    const { config } = session;
    const turns = engine.state.turns;
    let report: GameReport = {
      jobTitle: config.jobTitle,
      candidateName: config.candidateName,
      overall: 0,
      competencies: [],
      summary: "Interview berakhir sebelum ada jawaban yang bisa dinilai.",
      strengths: [],
      growthAreas: [],
      tips: "Coba lagi dan jawab setiap pertanyaan dengan contoh nyata.",
    };
    if (turns.some((t) => t.speaker === "CANDIDATE")) {
      try {
        const input = { jobTitle: config.jobTitle, competencies: config.competencies, turns };
        const [scores, feedback] = await Promise.all([
          scoreInterview(llm, input),
          generateCandidateFeedback(llm, input),
        ]);
        const byId = new Map<string, string>(config.competencies.map((c) => [c.id, c.name]));
        report = {
          jobTitle: config.jobTitle,
          candidateName: config.candidateName,
          overall: overallScore(scores.competencyScores, config.competencies),
          competencies: scores.competencyScores.map((s) => ({
            name: byId.get(s.competencyId) ?? s.competencyId,
            score: s.score,
            justification: s.justification,
          })),
          summary: scores.summary,
          strengths: feedback.strengths,
          growthAreas: feedback.growthAreas,
          tips: feedback.tips,
        };
      } catch (err) {
        console.error(JSON.stringify({ evt: "scoring_error", err: String(err) }));
      }
    }
    session.report = report;
    session.status = "done";
    send({ type: "report", report });
    console.log(JSON.stringify({ evt: "game_done", id: session.id, turns: turns.length }));
    setTimeout(() => ws.close(1000, "done"), 500);
  }

  // Engine calls serialized; .catch first so one failure can't poison the chain (selia pattern)
  let engineQueue: Promise<unknown> = Promise.resolve();
  const responder = (text: string, _signal: AbortSignal) => {
    const run = engineQueue.catch(() => {}).then(() => engine.onCandidateAnswer(text));
    engineQueue = run;
    return (async function* () {
      let reply: Awaited<ReturnType<typeof engine.onCandidateAnswer>>;
      try {
        reply = await run;
      } catch (err) {
        console.error(JSON.stringify({ evt: "engine_error", err: String(err) }));
        yield "Maaf, tadi sistem sempat terkendala sebentar. Bisa tolong ulangi jawabanmu?";
        return;
      }
      send({
        type: "progress",
        current: Math.min(engine.state.competencyIndex + 1, total),
        total,
        phase: engine.state.phase,
      });
      // let the closing line finish playing before scoring: a fixed delay cut
      // the goodbye mid-sentence (closing playout is ~12-15s and TTFB varies) —
      // wait until synthesized audio has actually drained, with a hard cap
      if (reply.done) {
        const t0 = Date.now();
        let sawAudio = false;
        const poll = setInterval(() => {
          const pending = pipeline.pendingPlayoutMs();
          if (pending > 0) sawAudio = true;
          const drained = sawAudio && pending === 0;
          if (drained || Date.now() - t0 > 45_000) {
            clearInterval(poll);
            void finalize().catch(console.error);
          }
        }, 500);
        poll.unref();
      }
      yield reply.utterance;
    })();
  };

  // mutable array shared with the pipeline — fills in the background
  const fillers: AudioChunk[][] = [];
  synthFillersInto(tts, fillers);

  const pipeline = new VoicePipeline({
    stt: sttFromEnv(CLIENT_SAMPLE_RATE),
    tts,
    responder,
    sink,
    latency: new LatencyRecorder(),
    fillers,
    events: {
      onCaption: (speaker, text) => send({ type: "caption", speaker, text }),
      onError: (err) => console.error(JSON.stringify({ evt: "pipeline_error", err: err.message })),
    },
  });
  await pipeline.start();
  send({ type: "ready", ttsSampleRate: tts.sampleRate, total, jobTitle: session.config.jobTitle });

  ws.on("message", (data: Buffer, isBinary) => {
    if (isBinary) {
      if (data.byteLength < 2) return;
      // copy — ws may reuse the underlying buffer across frames
      const even = data.byteLength - (data.byteLength % 2);
      const pcm = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + even));
      pipeline.pushAudio({ pcm, sampleRate: CLIENT_SAMPLE_RATE });
      return;
    }
    let msg: { type?: string };
    try {
      msg = JSON.parse(data.toString()) as { type?: string };
    } catch {
      return;
    }
    if (msg.type === "end") void finalize().catch(console.error);
  });

  ws.on("close", () => {
    clearInterval(watchdog);
    void pipeline.stop().catch(() => {});
    // player left mid-interview: no resume in the game — session is spent
    if (!finished) {
      finished = true;
      session.status = "done";
      console.log(JSON.stringify({ evt: "game_abandoned", id: session.id }));
    }
  });

  // budget watchdog: hard duration cap + idle cap (mic open, nobody answering —
  // streaming STT bills per minute whether or not anyone speaks)
  const startedAtMs = Date.now();
  const watchdog = setInterval(() => {
    if (finished) {
      clearInterval(watchdog);
      return;
    }
    const idleMs = Date.now() - engine.state.lastActiveAtMs;
    const totalMs = Date.now() - startedAtMs;
    if (totalMs > INTERVIEW_MAX_MS || idleMs > IDLE_MAX_MS) {
      console.log(
        JSON.stringify({ evt: "watchdog_finalize", id: session.id, totalMs, idleMs }),
      );
      void finalize().catch(console.error);
    }
  }, 15_000);
  watchdog.unref();

  const greeting = engine.begin();
  await pipeline.say(greeting.utterance);
}

server.listen(PORT, () => {
  console.log(JSON.stringify({ evt: "listening", port: PORT }));
});
