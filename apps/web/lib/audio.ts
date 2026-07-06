/**
 * Tiny chiptune audio engine — WebAudio only, zero asset files (Kenney audio
 * ships OGG, which Safari won't decode; oscillators work everywhere and match
 * the 8-bit fonts anyway). One lazy AudioContext, created on the first user
 * gesture that calls into here. BGM is a soft 8-bar arpeggio loop; SFX are
 * short synthesized blips. Mute persists to localStorage.
 */

const MUTE_KEY = "sim.muted";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let musicGain: GainNode | null = null;
let sfxGain: GainNode | null = null;
let musicTimer: ReturnType<typeof setInterval> | null = null;
let nextBarAt = 0;
let barIndex = 0;
let muted = false;

function ensure(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = 0.3;
    musicGain.connect(master);
    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.5;
    sfxGain.connect(master);
    muted = localStorage.getItem(MUTE_KEY) === "1";
    master.gain.value = muted ? 0 : 1;
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

export function isMuted(): boolean {
  if (typeof window === "undefined") return false;
  return ctx ? muted : localStorage.getItem(MUTE_KEY) === "1";
}

export function setMuted(m: boolean): void {
  muted = m;
  localStorage.setItem(MUTE_KEY, m ? "1" : "0");
  const c = ensure();
  if (c && master) master.gain.setTargetAtTime(m ? 0 : 1, c.currentTime, 0.05);
}

/** Lower the music under the interviewer's voice; restore afterwards. */
export function duckMusic(on: boolean): void {
  const c = ensure();
  if (c && musicGain) musicGain.gain.setTargetAtTime(on ? 0.08 : 0.3, c.currentTime, 0.4);
}

// --- BGM: I–vi–IV–V arpeggio, one chord per 2s bar, scheduled a bar ahead ---

const CHORDS = [
  [261.63, 329.63, 392.0], // C
  [220.0, 261.63, 329.63], // Am
  [174.61, 220.0, 261.63], // F
  [196.0, 246.94, 293.66], // G
];
const BAR_S = 2;

function scheduleBar(c: AudioContext, at: number, chord: number[]): void {
  if (!musicGain) return;
  // 8 gentle triangle arps per bar + a soft root an octave down
  for (let i = 0; i < 8; i++) {
    const t = at + (i * BAR_S) / 8;
    const freq = (chord[i % 3] ?? 261) * (i % 6 === 5 ? 2 : 1);
    blip(c, musicGain, "triangle", freq, t, 0.22, 0.05);
  }
  const root = (chord[0] ?? 261) / 2;
  blip(c, musicGain, "sine", root, at, BAR_S, 0.06);
}

export function startMusic(): void {
  const c = ensure();
  if (!c || musicTimer) return;
  nextBarAt = c.currentTime + 0.1;
  barIndex = 0;
  const tick = () => {
    // muted → schedule nothing at all (oscillators cost real CPU); keep the
    // clock caught up so unmuting doesn't burst a backlog of bars
    if (muted) {
      nextBarAt = Math.max(nextBarAt, c.currentTime);
      return;
    }
    // keep one bar scheduled ahead of the clock
    while (nextBarAt < c.currentTime + BAR_S) {
      scheduleBar(c, nextBarAt, CHORDS[barIndex % CHORDS.length] ?? CHORDS[0] ?? []);
      nextBarAt += BAR_S;
      barIndex++;
    }
  };
  tick();
  musicTimer = setInterval(tick, 500);
}

// --- SFX -------------------------------------------------------------------

/** One enveloped oscillator note. */
function blip(
  c: AudioContext,
  out: GainNode,
  type: OscillatorType,
  freq: number,
  at: number,
  dur: number,
  peak: number,
  glideTo?: number,
): void {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, at + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(peak, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, at + dur);
  o.connect(g).connect(out);
  o.start(at);
  o.stop(at + dur + 0.02);
}

export type SfxName = "click" | "sit" | "success";

export function sfx(name: SfxName): void {
  const c = ensure();
  if (!c || !sfxGain) return;
  const t = c.currentTime;
  switch (name) {
    case "click":
      blip(c, sfxGain, "square", 880, t, 0.07, 0.12);
      break;
    case "sit":
      blip(c, sfxGain, "triangle", 320, t, 0.28, 0.2, 130);
      break;
    case "success":
      blip(c, sfxGain, "square", 523.25, t, 0.14, 0.16);
      blip(c, sfxGain, "square", 659.25, t + 0.13, 0.14, 0.16);
      blip(c, sfxGain, "square", 783.99, t + 0.26, 0.3, 0.16);
      break;
  }
}
