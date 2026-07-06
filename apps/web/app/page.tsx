"use client";

import { Canvas } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { type GamePhase, Scene, type StickState } from "../components/scene";
import { type GameReport, type ServerMsg, VoiceClient } from "../lib/voice-client";

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
          ✎
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
  const [connecting, setConnecting] = useState(false);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [report, setReport] = useState<GameReport | null>(null);
  const sessionRef = useRef<string | null>(null);
  const clientRef = useRef<VoiceClient | null>(null);
  // stable ref for the avatar; swapped to the live client's ref on connect
  const aiLevelRef = useRef({ current: 0 });
  const stickRef = useRef<StickState>({ x: 0, z: 0 });
  const [touchUi, setTouchUi] = useState(false);

  useEffect(() => setTouchUi(window.matchMedia("(pointer: coarse)").matches), []);

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
        throw new Error(msg);
      }
      const data = (await res.json()) as { sessionId: string };
      sessionRef.current = data.sessionId;
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
      clientRef.current?.dispose();
      clientRef.current = null;
      setError(msg.reason);
      setPhase("lobby");
      return;
    }
    if (msg.type === "caption")
      setCaptions((prev) => [...prev.slice(-3), { speaker: msg.speaker, text: msg.text }]);
    else if (msg.type === "progress") setProgress({ current: msg.current, total: msg.total });
    else if (msg.type === "scoring") setPhase("scoring");
    else if (msg.type === "report") {
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
    setConnecting(true);
    const client = new VoiceClient();
    client.onMessage = handleMessage;
    clientRef.current = client;
    client
      .connect(`${WS_URL}/ws?session=${session}`)
      .then(() => {
        aiLevelRef.current = client.aiLevel;
        setConnecting(false);
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

  // E near the chair = sit down & start the interview
  useEffect(() => {
    if (phase !== "explore") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyE" && nearChair && !connecting) sit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, nearChair, connecting, sit]);

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
                : "Buat karaktermu sekali — nanti tinggal masuk kantor, jalan ke ruang interview, duduk, dan jawab dengan suaramu."}
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
            <button type="submit">Simpan karakter</button>
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
            <p className="sub" style={{ marginTop: 16 }}>
              Jalan ke ruang interview (WASD), duduk (E), dan jawab dengan suaramu — seperti
              wawancara sungguhan.
            </p>
            <button type="button" onClick={() => void start()} disabled={busy}>
              {busy ? "Menyiapkan ruangan…" : "▶ Masuk ke kantor"}
            </button>
            {error && <p className="error">{error}</p>}
          </div>
        </div>
      )}

      {phase !== "lobby" && profile && (
        <div className="hud">
          <ProfilePlate profile={profile} completed={completed} />
          {phase === "explore" && (
            <div className="hint">
              {connecting
                ? "Menyalakan mikrofon…"
                : nearChair
                  ? touchUi
                    ? "Tap tombol Duduk untuk mulai interview"
                    : "Tekan E untuk duduk dan mulai interview"
                  : touchUi
                    ? "Joystick untuk jalan · geser layar untuk putar kamera"
                    : "WASD jalan · drag mouse putar kamera · scroll zoom"}
            </div>
          )}
          {phase === "explore" && touchUi && <Joystick stick={stickRef} />}
          {phase === "explore" && touchUi && nearChair && !connecting && (
            <button type="button" className="sit-btn" onClick={sit}>
              🪑 Duduk
            </button>
          )}
          {phase === "interview" && (
            <>
              <div className="topbar">
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
            {report.tips && <p className="tips">💡 {report.tips}</p>}
            <button type="button" onClick={() => window.location.reload()}>
              Main lagi (LV {completed + 1})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
