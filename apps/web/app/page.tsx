"use client";

import { Canvas } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { type GamePhase, SEATS, Scene, type StickState } from "../components/scene";
import * as audio from "../lib/audio";
import { type GameReport, rms, type ServerMsg, VoiceClient } from "../lib/voice-client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4001";
const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4001";

const PROFILE_KEY = "sim.profile";
const COMPLETED_KEY = "sim.completed";

interface Profile {
  name: string;
  role: string;
}

interface Caption {
  speaker: "ai" | "candidate";
  text: string;
}

// --- pixel icons (crispEdges SVG on a 12×12 grid — matches the 8-bit fonts) ---

type Cell = [number, number, number?, number?];

function PxIcon({ cells, accent = [] }: { cells: Cell[]; accent?: Cell[] }) {
  const rects = (list: Cell[]) =>
    list.map(([x, y, w = 1, h = 1]) => <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} />);
  return (
    <svg width="14" height="14" viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden>
      <g fill="currentColor">{rects(cells)}</g>
      <g fill="#e07a6a">{rects(accent)}</g>
    </svg>
  );
}

const SPEAKER: Cell[] = [
  [1, 4, 2, 4],
  [3, 3, 1, 6],
  [4, 2, 1, 8],
];
const SPEAKER_WAVES: Cell[] = [
  [6, 5, 1, 2],
  [8, 3, 1, 1],
  [9, 4, 1, 4],
  [8, 8, 1, 1],
];
const SPEAKER_X: Cell[] = [[7, 4], [9, 4], [8, 5], [7, 6], [9, 6]];
const MIC: Cell[] = [
  [5, 1, 2, 6],
  [3, 4, 1, 3],
  [8, 4, 1, 3],
  [4, 7, 4, 1],
  [5, 8, 2, 1],
  [4, 9, 4, 1],
];
const SLASH: Cell[] = [
  [2, 10],
  [3, 9],
  [4, 8],
  [5, 7],
  [6, 6],
  [7, 5],
  [8, 4],
  [9, 3],
  [10, 2],
];
const PENCIL: Cell[] = [
  [2, 9],
  [2, 8],
  [3, 9],
  [3, 7],
  [4, 8],
  [4, 6],
  [5, 7],
  [5, 5],
  [6, 6],
  [6, 4],
  [7, 5],
  [7, 3],
  [8, 4],
  [8, 2],
  [9, 3],
];

const IconSpeakerOn = () => <PxIcon cells={[...SPEAKER, ...SPEAKER_WAVES]} />;
const IconSpeakerOff = () => <PxIcon cells={SPEAKER} accent={SPEAKER_X} />;
const IconMicOn = () => <PxIcon cells={MIC} />;
const IconMicOff = () => <PxIcon cells={MIC} accent={SLASH} />;
const IconPencil = () => <PxIcon cells={PENCIL} />;

/** Virtual thumbstick for touch devices — writes screen-relative x/z into `stick`. */
function Joystick({ stick }: { stick: { current: StickState } }) {
  const base = useRef<HTMLDivElement>(null);
  const pid = useRef(-1);
  const [thumb, setThumb] = useState({ x: 0, y: 0 });

  const track = (e: React.PointerEvent) => {
    const el = base.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    stick.current = { x: dx, z: dy };
    setThumb({ x: dx * 36, y: dy * 36 });
  };
  const release = () => {
    pid.current = -1;
    stick.current = { x: 0, z: 0 };
    setThumb({ x: 0, y: 0 });
  };

  return (
    // biome-ignore lint/a11y: game control, pointer-only by design
    <div
      ref={base}
      className="joystick"
      onPointerDown={(e) => {
        pid.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        track(e);
      }}
      onPointerMove={(e) => {
        if (e.pointerId === pid.current) track(e);
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <div className="thumb" style={{ transform: `translate(${thumb.x}px, ${thumb.y}px)` }} />
    </div>
  );
}

/**
 * Retro VU meter driven by a rAF-updated 0..1 level ref. Writes classes on the
 * bars directly each frame — no React re-render at 60fps.
 */
function MicMeter({ level, active = true }: { level: { current: number }; active?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const el = root.current;
      if (el) {
        const lit = active ? Math.min(5, Math.round(Math.min(1, level.current * 1.5) * 6)) : 0;
        el.childNodes.forEach((b, i) => {
          (b as HTMLElement).classList.toggle("lit", i < lit);
        });
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [level, active]);
  return (
    <div ref={root} className={`vu${active ? "" : " vu-off"}`} aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="vu-bar" style={{ height: 5 + i * 2.5 }} />
      ))}
    </div>
  );
}

/**
 * Lobby mic check: ask permission, meter the live input, confirm once speech is
 * heard. Also warms the permission so sitting down later starts instantly.
 */
function MicTest() {
  const [state, setState] = useState<"idle" | "testing" | "ok" | "denied">("idle");
  const level = useRef(0); // the ref object itself is the {current} the meter reads
  const stop = useRef<() => void>(() => {});
  useEffect(() => () => stop.current(), []);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      let raf = 0;
      const loop = () => {
        level.current = rms(analyser, buf);
        // one-way latch: enough signal = the mic definitely works
        if (level.current > 0.28) setState("ok");
        raf = requestAnimationFrame(loop);
      };
      setState("testing");
      loop();
      stop.current = () => {
        cancelAnimationFrame(raf);
        for (const t of stream.getTracks()) t.stop();
        void ctx.close().catch(() => {});
      };
    } catch {
      setState("denied");
    }
  };

  if (state === "idle")
    return (
      <button type="button" className="ghost mictest-btn" onClick={() => void start()}>
        <IconMicOn /> Tes mic dulu
      </button>
    );
  if (state === "denied")
    return <p className="error">Izin mikrofon ditolak — cek izin browser lalu muat ulang halaman.</p>;
  return (
    <div className={`mictest-live${state === "ok" ? " ok" : ""}`}>
      <MicMeter level={level} />
      <span>{state === "ok" ? "Mic OK — suaramu kedengeran!" : "Ngomong sesuatu…"}</span>
    </div>
  );
}

/** RPG-style nameplate: avatar, name, class (role), level + XP bar. */
function ProfilePlate({
  profile,
  completed,
  onEdit,
}: {
  profile: Profile;
  completed: number;
  onEdit?: () => void;
}) {
  return (
    <div className="plate">
      <div className="avatar">{profile.name.trim()[0]?.toUpperCase() ?? "?"}</div>
      <div className="plate-info">
        <span className="plate-name">{profile.name}</span>
        <span className="plate-role">{profile.role}</span>
        {/* ponytail: level = interviews finished; XP bar is cosmetic (5 per "ring") */}
        <div className="xp">
          <div className="xp-fill" style={{ width: `${(completed % 5) * 20}%` }} />
        </div>
      </div>
      <span className="lv">LV {completed + 1}</span>
      {onEdit && (
        <button type="button" className="edit" onClick={onEdit} title="Edit karakter">
          <IconPencil />
        </button>
      )}
    </div>
  );
}

export default function Game() {
  const [phase, setPhase] = useState<GamePhase>("lobby");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [completed, setCompleted] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftRole, setDraftRole] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [nearChair, setNearChair] = useState(false);
  const [nearSeat, setNearSeat] = useState<number | null>(null);
  const [seatIdx, setSeatIdx] = useState<number | null>(null);
  const [nearPaper, setNearPaper] = useState(false);
  const [reading, setReading] = useState(false);
  // attempts exhausted: roam-only mode — interview room sealed, game-over at the door
  const [lockedOut, setLockedOut] = useState(false);
  const [lockMsg, setLockMsg] = useState("");
  const [nearDoor, setNearDoor] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [report, setReport] = useState<GameReport | null>(null);
  const sessionRef = useRef<string | null>(null);
  const clientRef = useRef<VoiceClient | null>(null);
  /** Session reached a terminal state (report/denied/drop) — later closes are noise. */
  const finishedRef = useRef(false);
  // stable ref for the avatar; swapped to the live client's ref on connect
  const aiLevelRef = useRef({ current: 0 });
  const stickRef = useRef<StickState>({ x: 0, z: 0 });
  const [touchUi, setTouchUi] = useState(false);

  useEffect(() => setTouchUi(window.matchMedia("(pointer: coarse)").matches), []);

  const [mutedUi, setMutedUi] = useState(false);
  const [micOn, setMicOn] = useState(true);
  useEffect(() => setMutedUi(audio.isMuted()), []);

  // one listener gives every button a click blip
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("button")) audio.sfx("click");
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, []);

  // music under the interviewer's voice, full volume while roaming
  useEffect(() => {
    if (phase !== "lobby") audio.duckMusic(phase === "interview" || phase === "scoring");
  }, [phase]);

  useEffect(() => () => clientRef.current?.dispose(), []);

  // character is created once and persisted; the form comes back only via Edit
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (raw) {
        const p = JSON.parse(raw) as Profile;
        setProfile(p);
        setDraftName(p.name);
        setDraftRole(p.role);
      }
      setCompleted(Number(localStorage.getItem(COMPLETED_KEY) ?? 0) || 0);
    } catch {
      // corrupt storage → treat as first run
    }
    setLoaded(true);
  }, []);

  const saveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    const p: Profile = { name: draftName.trim(), role: draftRole.trim() };
    localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
    setProfile(p);
    setEditing(false);
  };

  const start = async () => {
    if (!profile) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobTitle: profile.role, candidateName: profile.name }),
      });
      if (!res.ok) {
        const body = await res.text();
        let msg = `server ${res.status}: ${body}`;
        try {
          msg = (JSON.parse(body) as { error?: string }).error ?? msg;
        } catch {
          // non-JSON error body — keep the raw text
        }
        if (res.status === 429) {
          // out of attempts — still let them into the office to roam the
          // lobby; the interview room is sealed and shows game-over instead
          setLockMsg(msg);
          setLockedOut(true);
          audio.startMusic();
          setPhase("explore");
          return;
        }
        throw new Error(msg);
      }
      const data = (await res.json()) as { sessionId: string };
      sessionRef.current = data.sessionId;
      audio.startMusic(); // inside the click gesture — autoplay-safe
      setPhase("explore");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleMessage = useCallback((msg: ServerMsg) => {
    if (msg.type === "denied") {
      // attempt cap hit — back to the menu with the server's explanation
      finishedRef.current = true;
      clientRef.current?.dispose();
      clientRef.current = null;
      setError(msg.reason);
      setPhase("lobby");
      return;
    }
    if (msg.type === "disconnected") {
      // socket dropped mid-interview (server restart, network). After a report
      // or denial the server closing is expected — ignore it there.
      if (finishedRef.current) return;
      finishedRef.current = true;
      clientRef.current?.dispose();
      clientRef.current = null;
      setError("Koneksi ke server terputus — sesi interview berakhir.");
      setPhase("lobby");
      return;
    }
    if (msg.type === "caption")
      setCaptions((prev) => [...prev.slice(-3), { speaker: msg.speaker, text: msg.text }]);
    else if (msg.type === "progress") setProgress({ current: msg.current, total: msg.total });
    else if (msg.type === "scoring") setPhase("scoring");
    else if (msg.type === "report") {
      audio.sfx("success");
      finishedRef.current = true;
      setReport(msg.report);
      setPhase("report");
      setCompleted((c) => {
        localStorage.setItem(COMPLETED_KEY, String(c + 1));
        return c + 1;
      });
    }
  }, []);

  const sit = useCallback(() => {
    const session = sessionRef.current;
    if (!session || clientRef.current) return;
    audio.sfx("sit");
    setConnecting(true);
    finishedRef.current = false; // fresh connection — closes matter again
    const client = new VoiceClient();
    client.onMessage = handleMessage;
    clientRef.current = client;
    client
      .connect(`${WS_URL}/ws?session=${session}`)
      .then(() => {
        aiLevelRef.current = client.aiLevel;
        setConnecting(false);
        setMicOn(true);
        setPhase("interview");
      })
      .catch((err) => {
        clientRef.current = null;
        setConnecting(false);
        setError(
          err instanceof Error && err.name === "NotAllowedError"
            ? "Izin mikrofon ditolak — muat ulang halaman dan izinkan mic untuk main."
            : String(err),
        );
      });
  }, [handleMessage]);

  const stand = useCallback(() => setSeatIdx(null), []);
  const sitCasual = useCallback(() => {
    if (nearSeat !== null) {
      audio.sfx("sit");
      setSeatIdx(nearSeat);
    }
  }, [nearSeat]);
  const openPaper = useCallback(() => {
    audio.sfx("paper");
    setReading(true);
  }, []);

  // E = sit/stand (interview chair takes priority), R = read the newspaper, Esc = close it
  useEffect(() => {
    if (phase !== "explore") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyE") {
        if (nearChair && !connecting) sit();
        else if (seatIdx !== null) stand();
        else if (nearSeat !== null) sitCasual();
      } else if (e.code === "KeyR" && !reading && nearPaper) {
        openPaper();
      } else if ((e.code === "Escape" || e.code === "KeyR") && reading) {
        setReading(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, nearChair, connecting, sit, seatIdx, nearSeat, nearPaper, reading, stand, sitCasual, openPaper]);

  const showForm = loaded && (editing || !profile);
  const showMenu = loaded && !editing && !!profile;

  return (
    <div className="game">
      <Canvas shadows dpr={[1, 2]} camera={{ fov: 60, position: [0, 2.4, 12] }}>
        <Suspense fallback={null}>
          <Scene
            phase={phase}
            onNearChair={setNearChair}
            aiLevel={aiLevelRef.current}
            stick={stickRef}
            seat={seatIdx !== null ? (SEATS[seatIdx] ?? null) : null}
            onNearSeat={setNearSeat}
            onNearPaper={setNearPaper}
            onStand={stand}
            onReadPaper={openPaper}
            inputLocked={reading}
            doorLocked={lockedOut}
            onNearDoor={setNearDoor}
          />
        </Suspense>
      </Canvas>

      {phase === "lobby" && showForm && (
        <div className="overlay">
          <form className="card lobby" onSubmit={saveProfile}>
            <h1>{profile ? "Edit Karakter" : "Interview Simulator"}</h1>
            <p className="sub">
              {profile
                ? "Ubah nama atau posisi yang kamu lamar."
                : "Selamat datang! di PT Mencari Cuan Sejati."}
            </p>
            <label>
              Nama panggilan
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Budi"
                maxLength={60}
                required
              />
            </label>
            <label>
              Posisi yang dilamar
              <input
                value={draftRole}
                onChange={(e) => setDraftRole(e.target.value)}
                placeholder="Frontend Engineer"
                maxLength={80}
                required
              />
            </label>
            <button type="submit">Simpan</button>
            {profile && (
              <button type="button" className="ghost" onClick={() => setEditing(false)}>
                Batal
              </button>
            )}
          </form>
        </div>
      )}

      {phase === "lobby" && showMenu && profile && (
        <div className="overlay">
          <div className="card lobby">
            <h1>Interview Simulator</h1>
            <ProfilePlate profile={profile} completed={completed} onEdit={() => setEditing(true)} />
            {/* <p className="sub" style={{ marginTop: 16 }}>
              Selamat datang di kantor PT Mencari Cuan Sejati. Jalan ke ruang interview (WASD), duduk (E), dan selamat berjuang!.
            </p> */}
            <MicTest />
            <button type="button" onClick={() => void start()} disabled={busy} style={{ marginTop: 16 }}>
              {busy ? "Menyiapkan ruangan…" : "▶ Masuk ke kantor"}
            </button>
            {error && <p className="error">{error}</p>}
          </div>
        </div>
      )}

      {phase !== "lobby" && profile && (
        <div className="hud">
          <ProfilePlate profile={profile} completed={completed} />
          <button
            type="button"
            className="mute-btn"
            title={mutedUi ? "Nyalakan suara" : "Bisukan"}
            onClick={() => {
              audio.setMuted(!mutedUi);
              setMutedUi(!mutedUi);
            }}
          >
            {mutedUi ? <IconSpeakerOff /> : <IconSpeakerOn />}
          </button>
          {phase === "explore" && !reading && (
            <div className="hint">
              {(() => {
                if (connecting) return "Menyalakan mikrofon…";
                if (nearChair)
                  return touchUi
                    ? "Tap tombol Duduk untuk mulai interview"
                    : "Tekan E untuk duduk dan mulai interview";
                const parts: string[] = [];
                if (seatIdx !== null) parts.push(touchUi ? "Tap Berdiri untuk bangun" : "E untuk berdiri");
                else if (nearSeat !== null)
                  parts.push(touchUi ? "Tap Duduk untuk santai" : "E untuk duduk santai");
                if (nearPaper) parts.push(touchUi ? "Tap Koran untuk baca" : "R untuk baca koran");
                if (parts.length > 0) return parts.join(" · ");
                return touchUi
                  ? "Joystick untuk jalan · geser layar untuk putar kamera"
                  : "WASD jalan · drag mouse putar kamera · scroll zoom";
              })()}
            </div>
          )}
          {phase === "explore" && touchUi && <Joystick stick={stickRef} />}
          {phase === "explore" && touchUi && nearChair && !connecting && (
            <button type="button" className="sit-btn" onClick={sit}>
              Duduk
            </button>
          )}
          {phase === "explore" && touchUi && !nearChair && (seatIdx !== null || nearSeat !== null) && (
            <button type="button" className="sit-btn" onClick={seatIdx !== null ? stand : sitCasual}>
              {seatIdx !== null ? "Berdiri" : "Duduk"}
            </button>
          )}
          {phase === "explore" && touchUi && nearPaper && !reading && (
            <button type="button" className="read-btn" onClick={openPaper}>
              Koran
            </button>
          )}
          {phase === "interview" && (
            <>
              <div className="topbar">
                <button
                  type="button"
                  className={`mic-btn${micOn ? "" : " off"}`}
                  aria-pressed={!micOn}
                  aria-label={micOn ? "Matikan mikrofon" : "Nyalakan mikrofon"}
                  onClick={() => {
                    const next = !micOn;
                    clientRef.current?.setMicEnabled(next);
                    setMicOn(next);
                  }}
                >
                  {micOn ? <IconMicOn /> : <IconMicOff />}
                </button>
                {clientRef.current && <MicMeter level={clientRef.current.micLevel} active={micOn} />}
                <span className="live">● live</span>
                {progress.total > 0 && (
                  <span>
                    Kompetensi {progress.current}/{progress.total}
                  </span>
                )}
                <button type="button" className="end" onClick={() => clientRef.current?.end()}>
                  Akhiri wawancara
                </button>
              </div>
              <div className="captions">
                {captions.map((c, i) => (
                  <p key={`${i}-${c.text.slice(0, 12)}`} className={c.speaker}>
                    <b>{c.speaker === "ai" ? "Interviewer" : "Kamu"}:</b> {c.text}
                  </p>
                ))}
              </div>
            </>
          )}
          {error && <p className="error floating">{error}</p>}
        </div>
      )}

      {reading && (
        // biome-ignore lint/a11y: backdrop dismiss; Esc/R and the ✕ button cover keyboard users
        <div className="overlay dim paper-zone" onClick={() => setReading(false)}>
          <article className="newspaper" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="paper-close" onClick={() => setReading(false)}>
              ✕
            </button>
            <header className="np-header">
              <p className="np-top">EDISI SPESIAL · HARGA: GRATIS, AMBIL SAJA · CUACA: CERAH BERAWAN PIXEL</p>
              <h1 className="np-mast">HARIAN CUAN</h1>
              <p className="np-motto">Koran resmi PT Mencari Cuan Sejati — akurasi berita dijamin 60%</p>
            </header>
            <h2 className="np-head">AJI PURNOMO: DALANG DI BALIK KANTOR VIRTUAL INI</h2>
            <p className="np-deck">
              Satu developer, satu misi: bikin latihan interview tidak lagi menyeramkan.
            </p>
            <div className="np-cols">
              <p>
                <b>LOBI KANTOR</b> — Sumber terpercaya menyebutkan seluruh gedung yang sedang Anda
                jelajahi ini — lantai kayu, sofa empuk, sampai pewawancara yang suka manggut-manggut
                itu — dirakit oleh satu orang: <b>Aji Purnomo</b>, AI Engineer merangkap Frontend
                Developer.
              </p>
              <p>
                Saksi mata melaporkan Aji terbiasa menyetel
                model AI di siang hari dan menggarap antarmuka web di malam hari. &ldquo;Kalau ketemu bug, saya tatap dulu lima menit. Kadang
                bugnya sadar diri lalu pergi sendiri,&rdquo; ujarnya santai kepada wartawan kami.
              </p>
              <aside className="np-facts">
                <h3>FAKTA SINGKAT</h3>
                <ul>
                  <li>Nama: Aji Purnomo</li>
                  <li>Kelas: AI Engineer</li>
                  <li>Sub-kelas: Frontend Developer</li>
                  <li>
                    Markas:{" "}
                    <a href="https://aji.is-a.dev" target="_blank" rel="noopener noreferrer">
                      aji.is-a.dev
                    </a>
                  </li>
                  <li>
                    Proyek:{" "}
                    <a href="https://fida.my.id" target="_blank" rel="noopener noreferrer">
                      Fida
                    </a>
                  </li>
                  <li>Status: open freelance akhir pekan (buruan)</li>
                </ul>
              </aside>
              <p>
                Proyek terbarunya, <b>Fida</b>, memastikan agen AI bisa membaca kode tanpa ikut
                membaca rahasia — secret diredaksi sebelum sampai ke model. Portofolio lengkapnya
                buka 24 jam di <b>aji.is-a.dev</b>, tanpa perlu janji temu.
              </p>
              <p>
                Ketika ditanya mengapa membangun simulator interview, ia menjawab, &ldquo;Biar semua
                orang bisa gladi bersih dulu. Grogi itu wajar — asal jangan pas ditanya HRD
                beneran.&rdquo;
              </p>
            </div>
            <footer className="np-foot">
              IKLAN BARIS: PT Mencari Cuan Sejati membuka lowongan untuk posisi apa pun yang Anda
              ketik di formulir tadi. Duduk di kursi ruang interview untuk melamar.
            </footer>
          </article>
        </div>
      )}

      {phase === "explore" && lockedOut && nearDoor && (
        // pointer-events: none — WASD/joystick keep working; walk away to dismiss
        <div className="overlay dim gameover-zone">
          <div className="gameover">
            <h1>GAME OVER</h1>
            <p className="go-msg">{lockMsg}</p>
            <p className="go-sub">
              Ruang interview sudah ditutup. Santai saja di lobby — duduk di sofa, baca koran.
            </p>
          </div>
        </div>
      )}

      {phase === "scoring" && (
        <div className="overlay dim">
          <div className="card">
            <h2>Interviewer sedang menilai…</h2>
            <p className="sub">Transkripmu dinilai per kompetensi.</p>
          </div>
        </div>
      )}

      {phase === "report" && report && (
        <div className="overlay dim">
          <div className="card report">
            <h2>Hasil — {report.jobTitle}</h2>
            <div className="overall">
              <span className="score">{report.overall.toFixed(1)}</span>
              <span className="of">/ 5</span>
            </div>
            <p className="sub">{report.summary}</p>
            {report.competencies.map((c) => (
              <div key={c.name} className="comp">
                <div className="comp-head">
                  <span>{c.name}</span>
                  <span>{c.score}/5</span>
                </div>
                <div className="bar">
                  <div className="fill" style={{ width: `${(c.score / 5) * 100}%` }} />
                </div>
                <p className="just">{c.justification}</p>
              </div>
            ))}
            {report.strengths.length > 0 && (
              <>
                <h3>Kekuatan</h3>
                <ul>
                  {report.strengths.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </>
            )}
            {report.growthAreas.length > 0 && (
              <>
                <h3>Yang bisa ditingkatkan</h3>
                <ul>
                  {report.growthAreas.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </>
            )}
            {report.tips && (
              <p className="tips">
                <b>TIP:</b> {report.tips}
              </p>
            )}
            <button type="button" onClick={() => window.location.reload()}>
              Main lagi (LV {completed + 1})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
