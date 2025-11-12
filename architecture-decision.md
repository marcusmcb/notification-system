# Feature Flags Architecture Decision

This document analyzes architectural approaches for a scalable feature flag system for 10,000+ schools with staged rollouts, tier gating, and targeted A/B testing.

## Section 1: Solution Approaches

### Approach A — Config file-based flags (YAML/JSON)
Description: Store flags in a versioned configuration file shipped with the app or fetched at startup. Applications read flags locally and enable/disable features at runtime.

Architecture overview:
- Flags defined in `flags.yml` (or JSON). Deployed with the application or hosted on object storage.
- App loads flags at boot (and optionally polls for changes).
- Targeting rules implemented in code (by school ID, tier, percentage).

Pros:
- Low cost and minimal infrastructure.
- Easy to audit via version control.
- Predictable performance (local reads).
- Simple to bootstrap for small teams.

Cons:
- Slow toggling (requires deploy or cache refresh cycle).
- Limited real-time control and kill-switch speed.
- Complex targeting logic leaks into app code.
- Coordination challenges across services/environments.

Complexity: Low

Example use case:
- Roll out “New Gradebook” to 5%: update YAML with percentage rule; apps pick up change on next poll (e.g., every 5 min). Emergency disable requires push or waiting for poll.

---

### Approach B — Database-driven flags with management UI
Description: Central service persists flags and targeting rules in a relational DB (e.g., Postgres). Services fetch flag evaluations via SDK or HTTP, with Redis caching for low latency.

Architecture overview:
- Tables: flags, variants, rules, segments (tier, school list), audits.
- Admin UI/API to edit flags (enable, percentage rollout, targeting).
- Evaluation API/SDK performs targeting with Redis cache and per-flag TTL.
- SDKs support local evaluation with cached rules, async refresh, and fast failover.

Pros:
- Real-time updates and instant kill-switch.
- Rich targeting (tiers, allowlists, percentage rollout, A/B tests).
- Centralized audit trail and governance.
- Horizontal scalability with caching and read replicas.

Cons:
- Higher build and ops complexity (service, UI, cache, migrations).
- Requires SDKs or shared client.
- Needs strong reliability patterns (circuit breakers, fallbacks).
- On-call ownership for a critical control plane.

Complexity: Medium

Example use case:
- Start at 5%, ramp to 25%, then 100% while excluding basic-tier: ops updates flag in UI; changes propagate instantly through cache; services evaluate locally with fallback defaults if API unreachable.

---

### Approach C — Third-party feature flag platform (e.g., LaunchDarkly, Flagsmith)
Description: Use a managed SaaS for flag management, targeting, experimentation, and SDKs.

Architecture overview:
- Integrate vendor SDK in services/clients.
- Define flags, segments, and experiments in vendor’s UI.
- SDKs stream or poll for rules; local evaluation with fast fallbacks.

Pros:
- Rapid time-to-value; mature UI and targeting.
- Strong reliability and global low latency.
- Built-in experimentation/metrics.
- Reduces long-term maintenance burden.

Cons:
- Ongoing cost that grows with usage.
- Vendor lock-in and data residency concerns.
- Requires procurement and compliance reviews.
- Potential SDK/runtime footprint and policy constraints.

Complexity: Low/Medium (integration-focused)

Example use case:
- Product schedules progressive rollout with tier gating and targeted schools; instant kill-switch from UI. Engineering focuses on integration and guardrails.

## Section 2: Detailed Recommendation

Recommendation: Approach B — Database-driven flags with Redis cache and lightweight SDKs.

Rationale:
- Balances scalability, control, and cost; avoids vendor lock-in while remaining production-grade.
- Real-time toggling with Redis and short TTLs provides instant kill-switches without redeploys.
- Extensible data model supports tier-based rules, allowlists, and percentage rollouts for 10k schools.
- Team can incrementally build core features, deferring advanced UI and experimentation until needed.

Implementation Plan:
1. Data model and migrations: flags, rules, segments, audits.
2. Evaluation engine library (Node): percentage bucketing, segment matching, tier rules.
3. HTTP API + Redis caching (GET /flags/:key/evaluate?schoolId=...&tier=...).
4. Minimal admin endpoints (CRUD) with RBAC and auditing.
5. SDK for Node services: background refresh, local cache, circuit breaker, default fallbacks.
6. Rollout protocol: publish->invalidate cache, stream updates to SDKs (SSE or pub/sub) later.
7. Observability: logs, metrics (p95 latency, error rate), tracing.
8. Admin UI v1 for product/ops, then add A/B test support.

Risk Mitigation:
- Single point of failure: implement client-side defaults, circuit breakers, and cached evaluations; deploy HA with replicas.
- Cache inconsistency: short TTL + explicit invalidation on writes; idempotent updates.
- Rule complexity bugs: exhaustive unit tests and canary flags; dry-run mode to preview impact.
- Access control/audit gaps: enforce RBAC, immutable audit logs, and change approvals for prod.

Success Metrics:
- Evaluation latency p95 < 10ms from cache, < 50ms from DB.
- Error rate < 0.1%; cache hit rate > 95%.
- Time to disable any flag < 5s globally.
- Adoption: % of services using SDK; # of incidents due to flags.

## Section 3: Team & Operational Considerations

Team Impact:
- Engineers use a consistent SDK with typed helpers; fewer custom env toggles.
- Documentation: flag lifecycle, naming conventions, targeting recipe examples.
- Training: safe rollout patterns, experimentation basics, and emergency kill-switch procedure.

Production Operations:
- Debugging: include flag metadata in logs (flag key, variant, reason); expose /diagnostics.
- Degradation: if the flag service is down, fall back to last-known values/defaults; surface alerts.
- Rollback: immediate disable via admin UI; versioned rules with revert; postmortems on incidents.
