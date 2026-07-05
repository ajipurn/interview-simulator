"use client";

import { Canvas } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { type GamePhase, Scene } from "../components/scene";
import { type GameReport, type ServerMsg, VoiceClient } from "../lib/voice-client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4001";
const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4001";

interface Caption {
  speaker: "ai" | "candidate";
  text: string;
}

export default function Game() {
  const [phase, setPhase] = useState<GamePhase>("lobby");
  const [jobTitle, setJobTitle] = useState("");
  const [name, setName] = useState("");
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

  useEffect(() => () => clientRef.current?.dispose(), []);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobTitle, candidateName: name }),
      });
      if (!res.ok) throw new Error(`server ${res.status}: ${await res.text()}`);
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
    if (msg.type === "caption")
      setCaptions((prev) => [...prev.slice(-3), { speaker: msg.speaker, text: msg.text }]);
    else if (msg.type === "progress")
      setProgress({ current: msg.current, total: msg.total });
    else if (msg.type === "scoring") setPhase("scoring");
    else if (msg.type === "report") {
      setReport(msg.report);
      setPhase("report");
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

  return (
    <div className="game">
      <Canvas shadows dpr={[1, 2]} camera={{ fov: 60, position: [0, 2.4, 12] }}>
        <Suspense fallback={null}>
          <Scene phase={phase} onNearChair={setNearChair} aiLevel={aiLevelRef.current} />
        </Suspense>
      </Canvas>

      {phase === "lobby" && (
        <div className="overlay">
          <form className="card lobby" onSubmit={start}>
            <h1>Interview Simulator</h1>
            <p className="sub">
              Masukkan posisi yang kamu lamar, jalan ke ruang interview (WASD / panah), duduk, dan
              jawab dengan suaramu — seperti wawancara sungguhan.
            </p>
            <label>
              Nama panggilan
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Budi"
                maxLength={60}
                required
              />
            </label>
            <label>
              Posisi yang dilamar
              <input
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                placeholder="Frontend Engineer"
                maxLength={80}
                required
              />
            </label>
            <button type="submit" disabled={busy}>
              {busy ? "Menyiapkan ruangan…" : "Masuk ke kantor"}
            </button>
            {error && <p className="error">{error}</p>}
          </form>
        </div>
      )}

      {(phase === "explore" || phase === "interview") && (
        <div className="hud">
          {phase === "explore" && (
            <div className="hint">
              {connecting
                ? "Menyalakan mikrofon…"
                : nearChair
                  ? "Tekan E untuk duduk dan mulai interview"
                  : "WASD / panah untuk jalan — masuk ke ruang interview"}
            </div>
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
              Main lagi
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
