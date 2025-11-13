# Feature Flags Architecture Decision (Readable Edition)

This document explains how we can roll out new features safely to 10,000+ schools. 

The goal: let us ship gradually (5% → 25% → 100%), target by subscription tier (basic/premium/enterprise), instantly turn off a feature if something goes wrong, and run A/B tests with specific schools. Think of it as “remote control” for features.

At a glance: 

- We compare three approaches with trade‑offs.
- We recommend a pragmatic middle path that the team can build and operate.
- We outline the rollout plan, risks, metrics, and how it affects day‑to‑day work.

## Section 1: Solution Approaches

### Approach A — Config file flags (YAML/JSON)

What it is: A simple file (like `flags.yml`) that lists which features are on/off and for whom. The app reads this file when it starts (or on a timer) and decides whether to show a feature.

How it works
- Keep a versioned config file with flags and basic rules (school IDs, tiers, percentages).
- App loads it at boot and optionally polls for changes every few minutes.
- Targeting logic (e.g., “premium tier only”) lives in application code.

Pros
- Cheap and easy to start. No new infrastructure.
- Safe and auditable via Git history.
- Very fast at runtime (it’s just reading memory).

Cons
- Changes are not instant (wait for redeploy or for the next poll).
- Limited targeting without adding more code complexity.
- Kill‑switches are slower; not ideal during incidents.

Complexity: Low

Example
- Roll out “New Gradebook” to 5%: update the file, merge to main, apps reload within ~5 minutes. Emergency off requires another change and a wait.

---

### Approach B — Database‑driven flags with a small management UI

What it is: Build a small service that stores flags and rules in a database (e.g., Postgres) and serves them to apps (via SDK or HTTP). Add Redis caching to make it faster and real‑time.

How it works

- Tables for flags, rules, segments (e.g., premium tier, allowlisted schools) and audit logs.
- An admin UI/API to create, edit, and instantly toggle flags.
- Services evaluate flags locally with a cached ruleset (refreshed every few seconds), with Redis to keep reads fast.

Pros

- Instant changes and kill‑switches; great for incident response.
- Powerful targeting and gradual rollouts (5% → 25% → 100%).
- Clear audit trail and central governance.
- Scales well with caching and read replicas.

Cons

- More to build and run (service + cache + UI + migrations).
- Requires a client SDK or common library for evaluation.
- We own reliability (circuit breakers, fallbacks, on‑call).

Complexity: Medium

Example
- Start at 5%, exclude basic tier, and allowlist School A and B. Product turns the dial in the UI; services pick up the change within seconds. If anything misbehaves, hit the kill‑switch and it’s off immediately.

---

### Approach C — Third‑party platform (e.g., LaunchDarkly, Flagsmith)
What it is: Use a SaaS feature flag service. We integrate their SDK and manage flags via their UI.

How it works

- Add vendor SDK to our services/clients.
- Define flags, segments, and experiments in the vendor UI.
- SDKs stream updates or poll; evaluation is local and very fast.

Pros

- Fastest path to value; polished UI and built‑in experimentation.
- High reliability and global low latency.
- Minimal maintenance for our team.

Cons

- Ongoing cost that grows with usage.
- Vendor lock‑in and potential data residency constraints.
- Procurement/compliance reviews; SDK policies to evaluate.

Complexity: Low/Medium (integration work)

Example

- Product schedules a staged rollout with tier gating from the vendor UI. Engineering focuses on integrating SDKs and guardrails. Emergency turn‑off is one click.

## Section 2: Our Recommendation (what we’d build and why)

Recommendation: Approach B — Database‑driven flags + Redis cache + lightweight SDKs.

Why this path

- Balance: We keep costs low and avoid vendor lock‑in, but still get instant toggles and strong targeting.
- Reliability: Cached, local evaluation means our apps keep working even if the flag service blips.
- Extensible: The data model cleanly supports tiers, allowlists, and percentage rollouts for 10,000 schools.
- Incremental: We can ship a useful v1 quickly and add UI niceties and experiments later.

Implementation plan (practical steps)

1) Data model and migrations: flags, rules, segments, audits.
2) Evaluation library (Node): percentage bucketing, segment matching, tier checks; strong unit tests.
3) API + Redis cache: GET /flags/:key/evaluate?schoolId=…&tier=…; short TTLs + cache invalidation on changes.
4) Minimal admin API/UI: CRUD with RBAC and audits; include a global kill‑switch.
5) Client SDK: background refresh, local cache, timeouts and circuit breaker, default fallbacks.
6) Realtime updates (later): push changes to SDKs via SSE or pub/sub to reduce TTL.
7) Observability: metrics (latency, errors, cache hit rate), structured logs, traces.
8) Admin UI v1: easy targeting, staged rollout sliders, and a dry‑run preview.

Key risks and how we’ll handle them

- Single point of failure → Clients always have defaults and last‑known values; timeouts + circuit breakers; HA deployment with replicas.
- Stale or inconsistent caches → Short TTLs (seconds) + explicit invalidation on writes; idempotent updates.
- Rule mistakes → Strong test coverage, canary flags, and a “preview impact” mode before saving.
- Access/audit gaps → RBAC, immutable audit logs, and change approvals for production environments.

How we’ll measure success

- p95 evaluation latency: < 10 ms (cache) and < 50 ms (DB).
- Error rate < 0.1%; cache hit rate > 95%.
- Time to kill‑switch any flag: < 5 seconds globally.
- Adoption: % of services using the SDK and number of incidents prevented/mitigated with flags.

## Section 3: Team and Operations (day‑to‑day impact)

Team workflow

- Engineers use a small SDK with clear, typed helpers—no more ad‑hoc env toggles.
- Documentation covers: naming conventions, targeting recipes, and safe rollout patterns.
- Quick onboarding for PMs/QA through the admin UI to self‑serve toggles (with RBAC).

Operating in production

- Debugging: log the evaluated variant and “why” (flag, rule, segment) on requests; include a /diagnostics endpoint.
- Degradation: if the flag service is down, apps keep using last‑known values; alerts page the on‑call.
- Rollback: instant disable via UI; versioned rules with revert; follow‑up postmortems for learnings.

