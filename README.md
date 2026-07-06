# Interview Simulator

Game web 3D untuk latihan wawancara kerja: buat karakter, ketik posisi yang dilamar, jalan-jalan di kantor pixel, duduk di kursi interview, lalu **wawancara suara real-time** dengan AI interviewer berbahasa Indonesia — diakhiri report skor per kompetensi + feedback.

> Tanpa API key pun jalan: semua provider default `mock` (offline penuh). Interviewer bicara nada sinus dan jawaban kandidat di-script — cukup untuk mencoba seluruh alur game.

## Fitur

- **Wawancara suara dua arah** — STT streaming dengan barge-in (potong ucapan interviewer kapan saja), TTS per kalimat dengan satu kalimat lookahead, caption live yang sinkron dengan audio.
- **Interview engine terstruktur** — state machine `OPENING → per kompetensi (core question + probe) → pertanyaan kandidat → CLOSING`. Rubric kompetensi digenerate dari posisi yang diketik; setiap ucapan AI melewati guardrail deterministik (anti bocor skor, redirect off-topic).
- **Respons terasa instan** — acknowledgement pendek pre-synthesized diputar begitu transkrip final tiba (menutup latency LLM+TTS), core question berikutnya di-prefetch saat kandidat masih menjawab, dan latency tiap giliran ter-log (`turn_latency`, budget p50 < 1,5s).
- **Report akhir** — skor 1–5 per kompetensi + justifikasi, kekuatan, area berkembang, dan tips.
- **Kantor 3D interaktif** — third-person (WASD / joystick touch), duduk di sofa mana pun, baca koran profil di meja tamu, tes mic di lobby, VU meter live selama interview.
- **Game over** — jatah interview habis? Tetap bisa masuk kantor dan santai di lobby; pintu ruang interview disegel papan "LOWONGAN DITUTUP".

## Arsitektur

Monorepo pnpm. Mesin interview & provider suara diambil dari selia (proyek interview-agent berbasis LiveKit); transport diganti WebSocket polos.

| Bagian | Peran |
|---|---|
| `packages/engine` | State machine interview, planner LLM, guardrails, rubric, scoring, feedback |
| `packages/voice-core` | Provider STT / LLM / TTS yang bisa ditukar via env (default mock) |
| `packages/shared` | Zod schemas |
| `apps/server` | HTTP + WebSocket: session, voice pipeline (STT → engine → TTS), budget guardrails |
| `apps/web` | Next.js + React Three Fiber: kantor 3D, HUD, klien audio WS |

## Menjalankan

```bash
pnpm install
pnpm dev        # server :4001 + web :3002
```

Buka http://localhost:3002. Untuk suara & otak asli, `cp .env.example .env` lalu isi provider (lihat tabel di bawah).

```bash
pnpm smoke      # e2e offline: session → WS → interview penuh → report
pnpm typecheck
pnpm test       # unit test engine + voice-core
```

## Provider (.env)

Pilih lewat `STT_PROVIDER`, `LLM_PROVIDER`, `TTS_PROVIDER` — semua default `mock`.

| Jenis | Pilihan | Env yang dibutuhkan |
|---|---|---|
| STT | `deepgram` | `DEEPGRAM_API_KEY` |
| LLM | `anthropic` | `ANTHROPIC_API_KEY` |
| | `openai` | `OPENAI_API_KEY` |
| | `azure-openai` | `AZURE_OPENAI_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` |
| | `gemini` | `GEMINI_API_KEY` |
| TTS | `gcloud` | `GOOGLE_APPLICATION_CREDENTIALS` (service account) atau `GOOGLE_TTS_API_KEY` |
| | `azure` | `AZURE_SPEECH_KEY` |
| | `elevenlabs` | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` |
| | `gemini` / `edge` | `GEMINI_API_KEY` / — |

## Protokol WS (apps/server)

- Client → server: binary = PCM int16 mono 16 kHz (mic), JSON `{type:"end"}`
- Server → client: binary = PCM int16 TTS (`ttsSampleRate` dari `ready`), JSON `ready | caption | clear (barge-in) | progress | scoring | report | denied`

## Kontrol

- **Desktop**: WASD / panah jalan · drag mouse putar kamera · scroll zoom · `E` duduk (kursi interview = mulai wawancara, sofa lobby = santai) · `R` baca koran · `Esc` tutup.
- **Touch**: joystick kiri bawah + tombol kontekstual (Duduk / Berdiri / Koran).

## Guardrails & budget

Ucapan AI melewati guardrail deterministik bawaan engine (anti bocor skor, redirect off-topic). Proteksi biaya di server (override via env, lihat `.env.example`):

- **Maks 2 interview per IP, seumur hidup** — persist di `apps/server/data/limits.json` (hapus file untuk reset saat dev, atau set `MAX_ATTEMPTS`).
- Maks 6 pembuatan session per IP per hari (tiap `POST /session` = 1 panggilan LLM rubric).
- Watchdog: interview dipaksa selesai setelah 12 menit, atau 3 menit idle (mic nyala tanpa jawaban) — STT streaming dibayar per menit.

## Asset 3D

Semua CC0 dari [Kenney](https://kenney.nl) (License.txt ikut di tiap folder):

- Karakter: [Mini Characters](https://kenney.nl/assets/mini-characters) — `apps/web/public/models/mini/`. Hanya yang dipakai yang di-ship: player `character-male-d`, interviewer `character-female-d` (tekstur `Textures/colormap.png` dipakai bersama). Ganti karakter: unduh pack-nya, salin `character-*.glb` lain, ganti nama file di `scene.tsx`.
- Furnitur: [Furniture Kit](https://kenney.nl/assets/furniture-kit) — `apps/web/public/models/furniture/`. Origin kit di sudut, komponen `Furn` me-recenter otomatis; skala global `FURN_SCALE`.

Dinding/lantai tetap primitif R3F — mereka yang mendefinisikan peta collision (`REGIONS`/`BLOCKERS` di `scene.tsx`). Musik & SFX disintesis via WebAudio (chiptune, nol file asset).
