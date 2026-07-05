/**
 * Offline e2e smoke: mock providers end-to-end over the real WS transport.
 * A fake candidate sends tone/silence cycles; MockStt's VAD turns each cycle
 * into the next scripted answer. PASS = full interview + report received.
 */
import { WebSocket } from "ws";

process.env.STT_PROVIDER = "mock";
process.env.LLM_PROVIDER = "mock";
process.env.TTS_PROVIDER = "mock";
process.env.PORT = "4111";
process.env.MOCK_STT_SCRIPT = JSON.stringify([
  "Halo, nama saya kandidat demo, salam kenal.",
  "Saya punya pengalaman dua tahun di bidang ini.",
  "Waktu itu saya memimpin proyek dengan tenggat ketat.",
  "Saya membagi tugas ke tim dan memantau progres tiap hari.",
  "Hasilnya proyek selesai tepat waktu dan klien puas.",
  "Saya belajar pentingnya komunikasi yang jelas.",
  "Contoh lainnya saya pernah menangani komplain pelanggan besar.",
  "Pelanggan tetap lanjut berlangganan setelah itu.",
  "Tidak ada pertanyaan, terima kasih.",
  "Tidak ada, cukup, terima kasih banyak.",
  "Tidak ada.",
  "Tidak.",
]);

await import("./index.js");

const BASE = "http://localhost:4111";
const SAMPLE_RATE = 16_000;
const deadline = Date.now() + 180_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(msg: string): never {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

// wait for the server
for (let i = 0; ; i++) {
  try {
    const r = await fetch(`${BASE}/health`);
    if (r.ok) break;
  } catch {
    if (i > 50) fail("server never came up");
    await sleep(100);
  }
}

const created = (await (
  await fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobTitle: "Frontend Engineer", candidateName: "Budi Demo" }),
  })
).json()) as { sessionId: string; competencies: string[] };
if (!created.sessionId || created.competencies.length === 0) fail("session create failed");
console.log("session:", created.sessionId, created.competencies);

const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?session=${created.sessionId}`);
let audioBytes = 0;
let aiCaptions = 0;
let candidateCaptions = 0;
let lastEvent = "";
let report: Record<string, unknown> | null = null;

ws.on("message", (data: Buffer, isBinary) => {
  if (isBinary) {
    audioBytes += data.byteLength;
    return;
  }
  const msg = JSON.parse(data.toString()) as { type: string; speaker?: string; text?: string };
  lastEvent = msg.type;
  if (msg.type === "caption") {
    if (msg.speaker === "ai") aiCaptions++;
    else candidateCaptions++;
    console.log(`  [${msg.speaker}] ${msg.text?.slice(0, 90)}`);
  } else if (msg.type === "report") {
    report = (msg as unknown as { report: Record<string, unknown> }).report;
  } else {
    console.log(`  <${msg.type}>`);
  }
});
await new Promise<void>((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});

/** One utterance as heard by the VAD: ~1.2s tone then ~1s silence, ~5x realtime pace. */
async function speakOneAnswer(): Promise<void> {
  const frame = Math.floor(SAMPLE_RATE * 0.04); // 40ms
  for (let i = 0; i < 30; i++) {
    const pcm = new Int16Array(frame);
    for (let s = 0; s < frame; s++) pcm[s] = Math.round(Math.sin((s + i * frame) / 6) * 9000);
    ws.send(Buffer.from(pcm.buffer));
    await sleep(8);
  }
  for (let i = 0; i < 25; i++) {
    ws.send(Buffer.from(new Int16Array(frame).buffer));
    await sleep(8);
  }
}

// converse until the report lands
let answersSent = 0;
while (!report) {
  if (Date.now() > deadline) fail(`timeout — lastEvent=${lastEvent}, answers=${answersSent}`);
  if (lastEvent === "scoring" || ws.readyState !== WebSocket.OPEN) {
    await sleep(500);
    continue;
  }
  if (aiCaptions > answersSent) {
    // the AI said something new since our last answer — reply
    await speakOneAnswer();
    answersSent++;
  }
  await sleep(300);
}

if (aiCaptions < 3) fail(`too few AI captions: ${aiCaptions}`);
if (candidateCaptions < 3) fail(`too few candidate captions: ${candidateCaptions}`);
if (audioBytes === 0) fail("no TTS audio received");
const r = report as { overall?: number; competencies?: unknown[]; strengths?: unknown[] };
if (typeof r.overall !== "number" || !Array.isArray(r.competencies) || r.competencies.length === 0)
  fail(`bad report: ${JSON.stringify(report).slice(0, 200)}`);

console.log(
  `SMOKE PASS — ai=${aiCaptions} candidate=${candidateCaptions} audioKB=${Math.round(audioBytes / 1024)} overall=${r.overall}`,
);
process.exit(0);
