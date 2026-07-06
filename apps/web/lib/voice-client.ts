/**
 * Browser side of the WS voice protocol (see README):
 * mic → AudioWorklet → 16 kHz int16 → WS; WS binary → scheduled AudioBuffers.
 * `aiLevel`/`micLevel` are rAF-updated 0..1 refs for the 3D avatar and HUD.
 */

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

export type ServerMsg =
  | { type: "ready"; ttsSampleRate: number; total: number; jobTitle: string }
  | { type: "caption"; speaker: "ai" | "candidate"; text: string }
  | { type: "clear" }
  | { type: "progress"; current: number; total: number; phase: string }
  | { type: "scoring" }
  | { type: "report"; report: GameReport }
  | { type: "denied"; reason: string };

const CAPTURE_WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.acc = []; this.len = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.acc.push(ch.slice(0));
      this.len += ch.length;
      if (this.len >= 2048) {
        const all = new Float32Array(this.len);
        let o = 0;
        for (const a of this.acc) { all.set(a, o); o += a.length; }
        this.acc = []; this.len = 0;
        this.port.postMessage(all, [all.buffer]);
      }
    }
    return true;
  }
}
registerProcessor("capture", Capture);
`;

const TARGET_RATE = 16_000;

/** Linear-interp downsample to 16 kHz, float32 → int16. */
function toPcm16k(input: Float32Array, inRate: number): Int16Array {
  if (inRate === TARGET_RATE) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++)
      out[i] = Math.max(-32768, Math.min(32767, Math.round((input[i] ?? 0) * 32767)));
    return out;
  }
  const ratio = inRate / TARGET_RATE;
  const n = Math.floor(input.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const s = (input[i0] ?? 0) * (1 - frac) + (input[i0 + 1] ?? input[i0] ?? 0) * frac;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  }
  return out;
}

function rms(analyser: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) {
    const d = (v - 128) / 128;
    sum += d * d;
  }
  return Math.min(1, Math.sqrt(sum / buf.length) * 4);
}

export class VoiceClient {
  readonly aiLevel = { current: 0 };
  readonly micLevel = { current: 0 };
  onMessage: (m: ServerMsg) => void = () => {};

  private ws: WebSocket | null = null;
  private micCtx: AudioContext | null = null;
  private outCtx: AudioContext | null = null;
  private outGain: GainNode | null = null;
  private ttsRate = 24_000;
  private nextAt = 0;
  private playing = new Set<AudioBufferSourceNode>();
  private raf = 0;
  private stream: MediaStream | null = null;
  private cleanupResume: () => void = () => {};

  async connect(wsUrl: string): Promise<void> {
    // mic capture
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const micCtx = new AudioContext();
    this.micCtx = micCtx;
    const workletUrl = URL.createObjectURL(
      new Blob([CAPTURE_WORKLET], { type: "text/javascript" }),
    );
    await micCtx.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);
    const src = micCtx.createMediaStreamSource(this.stream);
    const capture = new AudioWorkletNode(micCtx, "capture");
    const micAnalyser = micCtx.createAnalyser();
    micAnalyser.fftSize = 256;
    src.connect(micAnalyser);
    src.connect(capture);
    const mute = micCtx.createGain();
    mute.gain.value = 0; // worklet must reach the destination to be pulled; keep it silent
    capture.connect(mute).connect(micCtx.destination);

    // playback
    const outCtx = new AudioContext();
    this.outCtx = outCtx;
    const outGain = outCtx.createGain();
    const outAnalyser = outCtx.createAnalyser();
    outAnalyser.fftSize = 256;
    outGain.connect(outAnalyser);
    outAnalyser.connect(outCtx.destination);
    this.outGain = outGain;

    // Autoplay policy can hand us suspended contexts (no sound, no error, captions
    // still flow). Resume now — and if the browser refuses, on the next gesture.
    const resumeAll = () => {
      if (micCtx.state === "suspended") void micCtx.resume().catch(() => {});
      if (outCtx.state === "suspended") void outCtx.resume().catch(() => {});
    };
    resumeAll();
    window.addEventListener("pointerdown", resumeAll);
    window.addEventListener("keydown", resumeAll);
    this.cleanupResume = () => {
      window.removeEventListener("pointerdown", resumeAll);
      window.removeEventListener("keydown", resumeAll);
    };

    const micBuf = new Uint8Array(micAnalyser.frequencyBinCount);
    const outBuf = new Uint8Array(outAnalyser.frequencyBinCount);
    const loop = () => {
      this.micLevel.current = rms(micAnalyser, micBuf);
      this.aiLevel.current = rms(outAnalyser, outBuf);
      this.raf = requestAnimationFrame(loop);
    };
    loop();

    // ws
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WebSocket gagal terhubung"));
    });
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        this.enqueue(ev.data);
        return;
      }
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg;
      } catch {
        return;
      }
      if (msg.type === "ready") this.ttsRate = msg.ttsSampleRate;
      if (msg.type === "clear") this.flush();
      this.onMessage(msg);
    };

    capture.port.onmessage = (e) => {
      const pcm = toPcm16k(e.data as Float32Array, micCtx.sampleRate);
      if (ws.readyState === WebSocket.OPEN) ws.send(pcm.buffer);
    };
  }

  private enqueue(buf: ArrayBuffer): void {
    const outCtx = this.outCtx;
    const outGain = this.outGain;
    if (!outCtx || !outGain || buf.byteLength < 2) return;
    const i16 = new Int16Array(buf, 0, Math.floor(buf.byteLength / 2));
    const audio = outCtx.createBuffer(1, i16.length, this.ttsRate);
    const ch = audio.getChannelData(0);
    for (let i = 0; i < i16.length; i++) ch[i] = (i16[i] ?? 0) / 32768;
    const node = outCtx.createBufferSource();
    node.buffer = audio;
    node.connect(outGain);
    const t = Math.max(outCtx.currentTime + 0.03, this.nextAt);
    node.start(t);
    this.nextAt = t + audio.duration;
    this.playing.add(node);
    node.onended = () => this.playing.delete(node);
  }

  /** Barge-in: drop everything queued, start fresh. */
  private flush(): void {
    for (const node of this.playing) {
      try {
        node.stop();
      } catch {
        // already ended
      }
    }
    this.playing.clear();
    this.nextAt = 0;
  }

  end(): void {
    this.ws?.send(JSON.stringify({ type: "end" }));
  }

  dispose(): void {
    this.cleanupResume();
    cancelAnimationFrame(this.raf);
    this.flush();
    this.ws?.close();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    void this.micCtx?.close().catch(() => {});
    void this.outCtx?.close().catch(() => {});
  }
}
