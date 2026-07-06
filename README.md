# Interview Simulator

A 3D web game for practicing job interviews: create a character, type the role you're applying for, walk around a pixel office, take a seat in the interview room, and have a **real-time voice interview** with an AI interviewer (in Indonesian) — ending with a per-competency score report and feedback.

> Runs without any API keys: every provider defaults to `mock` (fully offline). The interviewer speaks in sine beeps and candidate answers are scripted — enough to try the whole game loop.

## Features

- **Two-way voice conversation** — streaming STT with barge-in (interrupt the interviewer any time), sentence-by-sentence TTS with one-sentence lookahead, live captions synced to the audio.
- **Structured interview engine** — a state machine: `OPENING → per competency (core question + probe) → candidate questions → CLOSING`. The competency rubric is generated from the role you type; every AI utterance passes deterministic guardrails (no score leaks, off-topic redirects).
- **Feels instant** — pre-synthesized acknowledgements play the moment your answer's final transcript arrives (masking LLM + TTS latency), the next core question is prefetched while you're still answering, and per-turn latency is logged (`turn_latency`, p50 budget < 1.5s).
- **Final report** — 1–5 score per competency with justification, strengths, growth areas, and tips.
- **An interactive 3D office** — third-person controls (WASD / touch joystick), sit on any sofa, read the newspaper on the coffee table, test your mic in the lobby, live VU meter during the interview.
- **Game over** — out of interview attempts? You can still enter the office and hang out in the lobby; the interview-room door is sealed with a "POSITION CLOSED" barricade.

## Architecture

A pnpm monorepo. The interview engine and voice providers were extracted from selia (a LiveKit-based interview-agent project); the transport was replaced with a plain WebSocket.

| Part | Role |
|---|---|
| `packages/engine` | Interview state machine, LLM planner, guardrails, rubric, scoring, feedback |
| `packages/voice-core` | Swappable STT / LLM / TTS providers, selected via env (default: mock) |
| `packages/shared` | Zod schemas |
| `apps/server` | HTTP + WebSocket: sessions, the voice pipeline (STT → engine → TTS), budget guardrails |
| `apps/web` | Next.js + React Three Fiber: the 3D office, HUD, WS audio client |

## Running

```bash
pnpm install
pnpm dev        # server :4001 + web :3002
```

Open http://localhost:3002. For a real voice and brain, `cp .env.example .env` and configure providers (table below).

```bash
pnpm smoke      # offline e2e: session → WS → full interview → report
pnpm typecheck
pnpm test       # engine + voice-core unit tests
```

## Providers (.env)

Selected via `STT_PROVIDER`, `LLM_PROVIDER`, `TTS_PROVIDER` — all default to `mock`.

| Kind | Option | Required env |
|---|---|---|
| STT | `deepgram` | `DEEPGRAM_API_KEY` |
| LLM | `anthropic` | `ANTHROPIC_API_KEY` |
| | `openai` | `OPENAI_API_KEY` |
| | `azure-openai` | `AZURE_OPENAI_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` |
| | `gemini` | `GEMINI_API_KEY` |
| TTS | `gcloud` | `GOOGLE_APPLICATION_CREDENTIALS` (service account) or `GOOGLE_TTS_API_KEY` |
| | `azure` | `AZURE_SPEECH_KEY` |
| | `elevenlabs` | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` |
| | `gemini` / `edge` | `GEMINI_API_KEY` / — |

## WS protocol (apps/server)

- Client → server: binary = PCM int16 mono 16 kHz (mic), JSON `{type:"end"}`
- Server → client: binary = PCM int16 TTS (`ttsSampleRate` from `ready`), JSON `ready | caption | clear (barge-in) | progress | scoring | report | denied`

## Controls

- **Desktop**: WASD / arrows to walk · drag mouse to orbit the camera · scroll to zoom · `E` to sit (interview chair starts the interview, lobby sofas are just for lounging) · `R` to read the newspaper · `Esc` to close it.
- **Touch**: joystick bottom-left + contextual buttons (Sit / Stand / Newspaper).

## Guardrails & budget

Every AI utterance passes the engine's deterministic guardrails (no score leaks, off-topic redirects). The server adds cost protection (all overridable via env, see `.env.example`):

- **Max 2 interviews per IP, lifetime** — persisted in `apps/server/data/limits.json` (delete the file to reset during dev, or set `MAX_ATTEMPTS`).
- Max 6 session creations per IP per day (each `POST /session` costs one rubric LLM call).
- Watchdog: an interview is force-finished after 12 minutes, or after 3 minutes of idle (mic open, nobody answering) — streaming STT bills per minute.

## Deploying

The web app is a standard Next.js app — Vercel works out of the box (root directory: `apps/web`). The server needs a **persistent Node process** (long-lived WebSockets, in-memory sessions): Railway, Render, Fly.io, or any VPS — not serverless. Start it with `pnpm --dir apps/server start`; it respects `PORT`.

Point the web app at the server via env, and use TLS — `getUserMedia` (mic) requires HTTPS, which also means the socket must be `wss://`:

```
NEXT_PUBLIC_API_URL=https://your-server.example.com
NEXT_PUBLIC_WS_URL=wss://your-server.example.com
```

## 3D assets

All CC0 from [Kenney](https://kenney.nl) (License.txt ships in each folder):

- Characters: [Mini Characters](https://kenney.nl/assets/mini-characters) — `apps/web/public/models/mini/`. Only the used models ship: player `character-male-d`, interviewer `character-female-d` (sharing `Textures/colormap.png`). To swap characters, download the pack, copy another `character-*.glb` in, and change the filename in `scene.tsx`.
- Furniture: [Furniture Kit](https://kenney.nl/assets/furniture-kit) — `apps/web/public/models/furniture/`. Kit origins sit at a corner; the `Furn` component recenters automatically, with a global `FURN_SCALE`.

Walls and floors stay as R3F primitives — they define the collision map (`REGIONS`/`BLOCKERS` in `scene.tsx`). Music and SFX are synthesized with WebAudio (chiptune, zero asset files).

## License

[MIT](LICENSE). Kenney assets are CC0.
