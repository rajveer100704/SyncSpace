# 🎨 SyncSpace

> A modern, persistent, collaboration-first whiteboard with real-time cursors, E2EE, and integrated video chat.

SyncSpace lets you sketch ideas, take notes, and collaborate live. It ships with three usage modes, robust state management via Redis, strong client‑side encryption, and a lean, containerized monorepo you can self‑host in minutes.

---

## ✨ Features

* **Three Modes**
  * **Solo** — Just open and draw. **End‑to‑end encrypted (E2EE)**; nothing leaves your device unencrypted.
  * **Private (Duo)** — 1:1 collaboration with **peer‑to‑peer WebRTC** video/audio and a lightweight WebSocket control channel. **E2EE** drawing payloads.
  * **Group** — Infinite participants with live shape broadcast over WebSocket. Shapes and room state are persisted in **Redis** (24h TTL) for resilience.

* **Real-Time Collaboration**
  * **Live Cursors** — See exactly where others are pointing with smooth, color-coded cursors.
  * **Persistent Rooms** — Room state (shapes, metadata) is saved in Redis, allowing users to refresh or rejoin without losing work.
  * **Smart Sync** — Initial state synchronization ensures new users get the complete picture instantly.

* **Privacy First** — Client‑side room keys and ephemeral sessions (auto-cleanup after inactivity).
* **Fast Canvas** — Custom canvas engine with selection, shapes, pencil, text, arrows, eraser, and keyboard shortcuts.
* **Rate Limiting & Queuing** — IP‑aware server limits + client‑side message queue with backoff to keep rooms smooth.
* **Video Calling** — Built‑in WebRTC for Duo rooms.
* **Authentication** — NextAuth with Google OAuth (optional for Solo, required for some org setups).
* **Modern Stack** — Next.js 15, TypeScript, Tailwind, shadcn/ui, native WebSocket, Redis, WebRTC, Docker.
* **Monorepo** — `apps/DrawDeck` (frontend), `apps/ws` (WebSocket), `apps/rtc` (RTC signaling).

---

## 📦 Monorepo layout

```
.
├─ apps/
│  ├─ DrawDeck/         # Next.js frontend (client + minimal server routes)
│  ├─ ws/               # WebSocket server (rooms, shapes, cursors, Redis persistence)
│  └─ rtc/              # RTC signaling server (for Duo video)
├─ packages/            # Shared packages
├─ docker/
│  ├─ Dockerfile.frontend
│  ├─ Dockerfile.websocket
│  └─ Dockerfile.rtc
├─ docker-compose.yml   # Orchestration for all services + Redis
├─ turbo.json           # Turborepo pipelines
├─ pnpm-workspace.yaml
└─ .github/workflows/   # CI/CD
```

---

## 🚀 Quick Start (Local Dev)

**Prerequisites**
* Docker & Docker Compose
* Node 18+ (Node 20 recommended)
* pnpm 9+

### Using Docker Compose (Recommended)
This starts the full stack: Frontend, WebSocket Server, RTC Server, and Redis.

```bash
docker compose up --build
```

### Manual Start
If you prefer running services individually (requires local Redis instance):

```bash
# 1. Start Redis (required for WS)
docker run -d -p 6379:6379 redis:alpine

# 2. Install dependencies
pnpm install

# 3. Start development servers
pnpm dev
```
> Or start individually:
> ```bash
> pnpm --filter @app/drawdeck dev
> pnpm --filter @app/ws dev
> pnpm --filter @app/rtc dev
> ```

---

## 🔧 Configuration

Environment variables are provided via `.env.local` in each app.

### Frontend (`apps/DrawDeck`)
```env
NEXT_PUBLIC_WS_URL=ws://localhost:8080
NEXT_PUBLIC_RTC_URL=http://localhost:8081
NEXT_PUBLIC_SITE_URL=http://localhost:3000

# NextAuth (Optional for local dev)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=
```

### WebSocket (`apps/ws`)
```env
PORT=8080
REDIS_URL=redis://localhost:6379
```

---

## 🧱 Architecture with Redis

```
┌────────────┐     WebRTC (P2P media)     ┌────────────┐
│  Client A  │◀──────────────────────────▶│  Client B  │
│  (Duo)     │                            │  (Duo)     │
└─────┬──────┘                            └─────┬──────┘
      │                                         │
      │   Shapes/Cursors (WS)                   │
      ▼                                         ▼
           ┌───────────────────────────────────┐
           │          WS Server (apps/ws)      │
           │  - Active connections (Memory)    │
           │  - Broadcast logic                │
           │  - Rate Limiting                  │
           └───────────────┬───────────────────┘
                           │
                           │ (Persistence)
                           ▼
           ┌───────────────────────────────────┐
           │             Redis                 │
           │  - Room Meta (Secret, type)       │
           │  - Shapes List (Persistence)      │
           │  - Session expiry (24h)           │
           └───────────────────────────────────┘
```

1.  **Frontend-First**: Next.js 15 handling UI, auth, and rendering.
2.  **WebSocket Layer**: Handles real-time shape updates and cursor movements. State is now decoupled from the WS server process, living in Redis.
3.  **Redis Persistence**: Rooms and shapes are stored in Redis with a 24-hour TTL, ensuring work is saved even if the server restarts or users disconnect temporarily.
4.  **Real-Time Cursors**: High-frequency cursor updates are broadcast via WebSocket (throttled) for a lively "multiplayer" feel.
5.  **Duo Mode**: Uses a separate RTC Signaling server (`apps/rtc`) to establish P2P WebRTC calls for video/audio.

---

## 🔐 Security & Privacy

*   **Room Access**: Protected by a 24-hour persistent secret.
*   **Encryption**: payloads are encrypted with the room key.
    *   **Solo/Duo**: Strictly E2EE (Server acts as blind relay).
    *   **Group**: Server relays active payloads. Persistence in Redis is currently valid JSON shapes, but payloads can remain encrypted if the client enforces it (current implementation validates keys on server for access control).
*   **Ephemeral Nature**: Redis keys expire after 24 hours of inactivity. No long-term database storage means no data liabilities.

---

## 🐳 Docker Production Build

```bash
# Build Frontend
docker build -f docker/Dockerfile.frontend -t acidop/drawdeck-frontend:latest .

# Build WebSocket
docker build -f docker/Dockerfile.websocket -t acidop/drawdeck-ws:latest .

# Build RTC
docker build -f docker/Dockerfile.rtc -t acidop/drawdeck-rtc:latest .
```

---

## 🤝 Contributing

PRs and issues welcome!
1.  Fork & branch from `main`.
2.  `pnpm install`
3.  `docker compose up --build` to test.
4.  Open a PR.

---

## 📜 License

MIT. See `LICENSE`.
