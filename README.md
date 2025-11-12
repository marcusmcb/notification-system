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

- In-memory storage is acceptable for demo/testing; in production this would be Redis for connection routing and missed-notification queues.
- Message payloads are small text messages; no PII beyond student identifiers in demo.
- 24h retention is sufficient per requirements.

## Time spent

- Part 1: TODO
- Part 2: TODO

## Reflection

- Technical decisions: Focused on simple, observable SSE with strong cleanup and a bounded missed-notification buffer; chose Fastify for performance and ergonomics.
- With more time: Add Redis-backed pub/sub, horizontal scale with connection fan-out, authentication, and backpressure controls.
- Scaling to 100,000 concurrent connections: Use clustering with Node workers, terminate TLS at a proxy that supports HTTP/1.1 keep-alive, shard connections via sticky routing, offload missed notifications to Redis streams/lists with TTL, and implement backplane pub/sub (e.g., Redis, NATS). Add per-student connection tracking in Redis and move cleanup to heartbeats.

