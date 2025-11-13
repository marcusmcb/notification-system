# notification-system

User-notification system design example

Marcus McBride, 2025

## How to run

Prerequisites: Node 18+ recommended.

1) Install dependencies

```bash
npm install
```

2) Start the server (default http://localhost:3000)

```bash
npm start
```

Endpoints:
- `GET /sse?studentId=ID` — subscribe to grade notifications via Server-Sent Events
- `POST /publish` — body: `{ studentId, message }`
- `POST /publish/batch` — body: `{ notifications: [{ studentId, message }, ...] }`
- `GET /metrics` — simple in-memory metrics for tests
- `GET /health` — health check

## How to run tests

Uses Playwright test runner.

```bash
npx playwright install --with-deps
npm test
```

## SSE implementation approach

- Fastify-based SSE endpoint keeps a per-student set of active connections in memory with a limit of 3 devices. Oldest connections are closed when the limit is exceeded.

- Notifications are stored in memory for 24 hours and pruned periodically; on reconnect, missed notifications are replayed before live streaming.

- Keep-alive comments are sent every 15s to keep proxies from closing the stream; cleanup occurs on `close` and `end` events.

- Batch and single publish endpoints broadcast to all active connections for the targeted student(s) and store to the missed buffer.

## Assumptions

- In-memory storage is acceptable for demo/testing; in production this would be a Redis-type service for connection routing and missed-notification queues.

- Message payloads are small text messages

- 24h retention is sufficient per requirements.

## Time spent

- Part 1: 30 minutes
- Part 2: 30 minutes

## Generative AI tools utilized:

- GPT-5 running in Agent mode within VS Code
- Co-Pilot (code autocomplete) within VS Code

## Additions not outlined in the original requirements

- added a simple HTML front end to /public for demonstration purposes

- refactored environment constants and type declarations as stand alone modules

- refactored codebase to consistently utilize the modern JavaScript arrow syntax

## Reflection

- Technical decisions (plain-language overview):

	- SSE vs WebSockets: We chose Server‑Sent Events because the problem is one‑way (server → client). SSE is lighter weight, simpler to run behind proxies, and perfect for streaming simple updates like “grades posted.”

	- Connection tracking: The server keeps an in‑memory list of open browser tabs/devices per student and enforces a 3‑device limit, with the eldest device removed if a fourth joins. 

	- Missed notifications: If a student disconnects, we store recent messages for 24 hours. When they reconnect, we replay what they missed since last connection.

	- Cleanup and keep‑alive: We clean up on close/end events so memory isn’t leaked, and send a tiny “ping” every 15 seconds to keep the connection alive through proxies/CDNs.

	- Framework choice: Fastify is team-familiar, as well as fast and ergonomic, which keeps code small and readable while handling a lot of connections efficiently

	- Testing: Playwright tests spin up the real server and simulate requests and SSE streams, so we verify the full request/response lifecycle (including missed‑message replay and cleanup).

- With more time (what we’d add next):

	- Authentication and security: Require a token on `/sse` and publishing endpoints; add CORS rules and basic rate‑limits to prevent abuse.

	- Durable storage and scale‑out: Move missed notifications and presence tracking to Redis so multiple server instances can share state.

	- Observability: Add structured logging, per‑student metrics, and tracing to spot slowdowns or stuck connections.

	- Admin tooling: A small UI to view connected students, force disconnects, and inspect recent notifications.

	- Robustness: Backpressure controls (throttling), idempotency keys for publish calls, and graceful shutdown to drain connections safely.

- Scaling to ~100,000 concurrent connections (approach):

	- Horizontal scale: Run multiple server instances behind a load balancer; use sticky routing so a student’s stream stays on the same instance.

	- Externalize state: Keep connection presence and missed notifications in Redis; use pub/sub (Redis or NATS) to fan‑out new messages to all instances.

	- Efficient networking: Terminate TLS at a proxy optimized for many keep‑alive connections (e.g., nginx/Envoy), and keep SSE running over HTTP/1.1.

	- Resilience patterns: Heartbeats to detect dead connections, aggressive cleanup, short timeouts, circuit breakers, and retries where appropriate.

	- Operational guardrails: Auto‑scaling on connection count, dashboards for connection churn, and alerts on error spikes or cache misses.

