# Interview Simulator

Web game 3D: masukkan posisi yang dilamar, kamu "disummon" ke sebuah kantor, kamera berjalan masuk ke ruang interview, lalu wawancara suara real-time dengan AI interviewer — diakhiri report skor + feedback.

Mesin interview diambil dari [selia](../selia) (sibling repo):

| Bagian | Asal | Catatan |
|---|---|---|
| `packages/engine` | copy dari selia | state machine interview, guardrails, rubric, scoring, feedback |
| `packages/voice-core` | copy dari selia | provider STT/LLM/TTS (default mock = offline) |
| `packages/shared` | copy dari selia | zod schemas |
| `apps/server/src/pipeline.ts`, `latency.ts` | copy dari `selia/apps/agent` | voice loop transport-agnostic |
| `apps/server/src/index.ts` | baru | transport WebSocket (pengganti LiveKit), session in-memory |
| `apps/web` | baru | Next.js + React Three Fiber |

## Jalankan

```bash
pnpm install
pnpm dev        # server :4001 + web :3002
```

Buka http://localhost:3002 — tanpa `.env` semua provider mock (interviewer bicara nada sinus, jawaban kandidat di-script). Untuk suara & otak asli, `cp .env.example .env` dan isi provider seperti di selia.

```bash
pnpm smoke      # e2e offline: session → WS → interview penuh → report
pnpm typecheck
pnpm test       # unit test bawaan engine + voice-core
```

## Protokol WS (apps/server)

- Client → server: binary = PCM int16 mono 16 kHz (mic), JSON `{type:"end"}`
- Server → client: binary = PCM int16 TTS (`ttsSampleRate` dari `ready`), JSON `ready | caption | clear (barge-in) | progress | scoring | report`

## Kontrol

WASD / panah = jalan (third person) · E dekat kursi = duduk & mulai interview · tombol "Akhiri wawancara" = selesai lebih awal.

## Asset 3D

Semua CC0 dari Kenney (License.txt ikut di tiap folder):

- Karakter: [Mini Characters](https://kenney.nl/assets/mini-characters) — `apps/web/public/models/mini/`. Player `character-male-a`, interviewer `character-female-a`; ganti = ganti nama file (`character-{male,female}-a..f.glb`, tekstur `Textures/colormap.png` dipakai bersama).
- Furnitur: [Furniture Kit](https://kenney.nl/assets/furniture-kit) — `apps/web/public/models/furniture/`. Origin kit di sudut, komponen `Furn` me-recenter otomatis; skala global `FURN_SCALE` (kit ~setengah meter-scale).

Dinding/lantai tetap primitif R3F — mereka yang mendefinisikan peta collision (`REGIONS`/`BLOCKERS` di scene.tsx).
