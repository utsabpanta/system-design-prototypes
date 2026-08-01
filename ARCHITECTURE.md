# Architecture

Design notes for the cell-based multi-tenant prototype. For how to run it, see
[README.md](./README.md).

---

## 1. The shape

```
                    ┌──────────────── CONTROL PLANE (one stack) ─────────────────┐
                    │  Admin API      tenants · routing · cells · ratelimit tbls │
                    │  Router         Step Functions migration workflow          │
                    └────────────────────────────────────────────────────────────┘
                                        │ pulls telemetry / reads routing
  client ──► Router (APIGW + Lambda) ───┤
             x-tenant-id header         │  routing lookup (5s cache) → token
                                        ▼  bucket → forward to the cell
   ┌───────── cell-a (pooled) ────────┬───── cell-b (pooled) ─────┬──── cell-c (silo) ────┐
   │ APIGW → api Lambda               │  identical stack,         │  identical stack,     │
   │ DynamoDB tasks  (pk=TENANT#id)   │  independently            │  one premium tenant   │
   │ SQS queue + DLQ → worker Lambda  │  deployable               │                       │
   │ DynamoDB metrics                 │                           │                       │
   │ SSM /cells/<id>/fault  ← chaos   │                           │                       │
   └──────────────────────────────────┴───────────────────────────┴───────────────────────┘
```

A **cell** is a complete, self-sufficient copy of the data plane. Everything a
tenant's request touches — API, compute, table, queue, telemetry — lives inside
one CloudFormation stack. The **control plane** owns tenant identity, the
tenant→cell map, placement, and migration; it is deliberately *off* the critical
path for a cell serving traffic.

### Request lifecycle

1. Client sends `POST /v1/tasks` with an `x-tenant-id` header to the router.
2. Router looks up `cp-routing` (5s in-memory cache) → cell id, tier, rate limit.
3. Router spends a token from the tenant's bucket. Over budget → `429 + Retry-After`.
4. Router forwards to the cell's API Gateway, stamping tenant id, tier, and status.
5. Cell's api Lambda builds a `TenantContext`, writes the task to its own DynamoDB
   table under `pk = TENANT#<id>`, enqueues to its own SQS queue, returns `202`.
6. Cell's worker Lambda drains that queue and flips the task to `completed`.

Every response carries `x-cell-id`, so tests, the load generator, and the
dashboard can attribute any request to a cell without inference.

---

## 2. Design decisions

### Cells are independent CloudFormation stacks

`infra/lib/cell-stack.ts` is instantiated once per entry in
`infra/lib/cells.config.ts`. There are **no CloudFormation exports between cells
and no imports from the control plane**, so `cdklocal deploy Cell-a` provably
cannot touch Cell-b.

Discovery happens at *runtime* through SSM (`packages/shared/cell-directory.ts`):
each cell publishes its coordinates to `/cells/<id>/config`, and the control
plane reads them back. Using CloudFormation exports instead would have been
simpler to write, but it would create a synth-time dependency graph between
cells — precisely the coupling the architecture exists to prevent.

Adding a cell is one line in `cells.config.ts` plus a deploy. No existing cell is
modified and no tenant moves.

### Routing is an explicit stored mapping, not a hash

A `hash(tenantId) % N` router needs no state at all, which is genuinely
attractive. It was rejected because it makes two things impossible:

- **Silo placement** — you cannot pin one premium tenant to a dedicated cell if
  placement is a pure function of the tenant id.
- **Migration** — moving one tenant means changing `N` or the hash, which
  relocates *everyone*.

One row per tenant in `cp-routing` costs a cached lookup per request and buys
both. The cache TTL (5s) is also why migration has a settle step: it bounds how
long a warm router instance can hold a stale mapping.

### Tiered ("bridge") isolation

| Tier | Placement | Isolation |
|---|---|---|
| standard | pooled cell, shared table, `pk = TENANT#<id>` | logical + IAM-scoped |
| premium | silo cell, one tenant only | physical |

`packages/shared/placement.ts` picks the least-loaded eligible cell and **refuses
to overfill**. When nothing has capacity it throws `NoCapacityError` → `507`,
telling the operator to deploy another cell. Silently exceeding capacity would
erase the very property the tier was sold on, so the refusal is the feature.

Placement claims a slot with a conditional `tenantCount < capacity` update
*before* writing the tenant, so two concurrent onboardings cannot both take the
last slot; the loser retries against the next candidate.

### Isolation is enforced in two layers

**Layer 1 — structural.** `TaskRepository`
(`packages/shared/task-repository.ts`) is constructed from a `TenantContext`, and
**no method takes a tenant id**. A handler holding tenant A's repository has no
expressible way to read tenant B's data. Key construction lives inside the
repository too, so no caller is ever in a position to hand-build a foreign
partition key.

**Layer 2 — IAM.** Before touching data, the api Lambda re-assumes its own role
with a *session policy* scoped by `dynamodb:LeadingKeys` to the caller's
partition, plus an explicit `Deny` on `Scan` (which `LeadingKeys` cannot
constrain). Even a hypothetical bug in layer 1 would be denied by IAM.

> **Local caveat:** LocalStack's free tier does not reliably evaluate session
> policies, so layer 2 is present but not enforced locally. The generated policy
> is unit-tested instead (`test/unit/placement.test.ts`), and the vending code
> path runs on every request so it cannot rot.

A cross-tenant read returns **404, not 403** — a tenant learns nothing about
whether an id exists in someone else's partition.

### Cells own their telemetry

Metrics live in each cell's own DynamoDB table, bucketed per minute. The control
plane **pulls** them when the dashboard asks; cells never push.

This is an availability decision, not a storage one. A cell must not depend on
the control plane to serve traffic, and a wedged control plane must not become a
cross-cell failure. The `/admin/overview` endpoint catches per-cell failures
individually, so an unreachable cell reports as unreachable rather than taking
the whole overview down. On real AWS this would be CloudWatch EMF; a DynamoDB
counter table is the local stand-in that preserves the ownership boundary.

### The rate limiter is two atomic writes, not read-modify-write

The obvious implementation — read the bucket, compute a continuous refill from
elapsed time, write back under a version check — was built first and
**measurably failed**. At 30 concurrent requests nearly every caller read the
same version, one write won, the rest exhausted their retries and were waved
through. A limiter defeated by exactly the burst it exists to stop.

The current design (`packages/shared/rate-limiter.ts`) has no read-modify-write:

1. `ADD tokens -1` conditional on `tokens >= 1` — fully atomic, never contends.
   This is the common path.
2. If that fails, try to refill: set the bucket to full conditional on a whole
   refill interval having elapsed. Exactly one concurrent caller wins; the losers
   are throttled.

The cost is that refill is stepwise (a sawtooth every `burst/rps` seconds) rather
than a smooth trickle. The long-run rate is still `rps`, and it cannot be
defeated by concurrency.

### Bulkheads

Two separate mechanisms limit blast radius:

- **Cell boundary** — a fault in one cell's Lambda, table, or queue has no shared
  component to propagate through.
- **Reserved concurrency** — each cell's api Lambda reserves a slice of the
  account's concurrency (`reservedConcurrency` in `cells.config.ts`), so a cell
  saturating under load cannot starve its siblings.

---

## 3. Tenant migration

The operation that justifies the explicit routing map. Implemented as a Step
Functions state machine over `packages/services/migration/index.ts`.

```
freeze → drain → copy → verify → cutover → settle → cleanup → ✓
  └────────┴───────┴───────┘
       any failure → rollback → ✗
```

| Step | What it does | Why it's here |
|---|---|---|
| **freeze** | `routing.status = READ_ONLY` | Reads keep working; writes get `409`. The only user-visible impact, bounded by copy time |
| **drain** | Wait for the source queue to empty | Stops workers writing to the source mid-copy |
| **copy** | Page the tenant's items source → target | — |
| **verify** | Compare item counts | Aborts *before* cutover, so the failure mode is "migration didn't happen", not "half the data is missing" |
| **cutover** | Point routing at the target, status `ACTIVE` | A single item write — the closest thing to atomic available, deliberately the last irreversible step |
| **settle** | Wait out the router's route cache TTL | No warm router instance may still be writing to the source |
| **cleanup** | Delete the source copy, rebalance occupancy | Safe only after settle |

Everything up to and including **verify** catches to `rollback`, which restores
`ACTIVE` on the source and deletes whatever the aborted copy left in the target.
After cutover the tenant is already live in the target, so a cleanup failure
leaves untidy rows but must *not* trigger a rollback.

Rollback unfreezes **before** cleaning up: a tenant stranded in `READ_ONLY` is an
outage, whereas orphaned rows in a cell nobody routes to are merely untidy.

`drain` has a 60s timeout and then proceeds. In a pooled cell the queue is shared,
so a busy neighbour could keep it non-empty indefinitely — and proceeding is safe
because the migrating tenant is already frozen and cannot enqueue anything new.

---

## 4. What's different from real AWS

Everything here is a consequence of the free LocalStack tier or of running on a
laptop. **Nothing in this list is a property of the architecture.**

| Area | This prototype | Real AWS | Why |
|---|---|---|---|
| Cell routing | API Gateway + Lambda router | Route 53 latency/weighted records, ALB, or CloudFront + Lambda@Edge | ALB and Route 53 hosted zones are not in the free tier |
| Cell entry | API Gateway **REST (v1)** | HTTP API (v2) — cheaper, faster | `apigatewayv2` is Pro-only; `pnpm run smoke` confirms this every run |
| Compute | Lambda only | ECS/Fargate is often the better cell shape for long-lived services | No ECS in the free tier |
| Relational data | DynamoDB only | RDS/Aurora per cell is common for silo tenants | No RDS in the free tier |
| Identity | `x-tenant-id` header, trusted from the router | Cognito/OIDC + a Lambda authorizer producing verified claims | No Cognito in the free tier. **The header is unauthenticated — this is a prototype, not a security model** |
| IAM enforcement | Session policies generated, not enforced | Actually enforced | Free-tier limitation; try `ENFORCE_IAM=1` in `docker-compose.yml` |
| Concurrency | ~12 concurrent requests | Effectively unbounded | LocalStack runs **one Docker container per Lambda invocation**. A 25-wide burst reproducibly wedges it — see `packages/shared/concurrency.ts` |
| Rate limits | standard 2 rps / premium 50 rps | hundreds to thousands | A realistic limit could never be reached locally, making throttling unobservable |
| Regions | Single region | Cells usually span AZs, sometimes regions | One LocalStack instance |
| State | Lost on restart | Durable | Persistence is a Pro feature; `pnpm run reset` re-creates everything |

### Portability

Every AWS client reads `AWS_ENDPOINT_URL` from one place
(`packages/shared/aws.ts`) and omits it when unset. `tools/with-local-env.sh` is
the only thing that sets it. Drop that wrapper and `cdk deploy` targets a real
account.

Before doing so you would want to: replace the router with Route 53 or ALB, raise
the rate limits, put a real authorizer in front of `x-tenant-id`, and decide
whether cells should span AZs.

---

## 5. Repository layout

```
infra/
  bin/app.ts                  CDK app: ControlPlaneStack + CellStack × N
  lib/cells.config.ts         the cell inventory — the only place cell count lives
  lib/cell-stack.ts           one cell: API, compute, table, queue, metrics, chaos knob
  lib/control-plane-stack.ts  routing/tenant/cell tables, router, admin API, migration SFN
  lib/lambda-defaults.ts      shared NodejsFunction wiring + local endpoint injection

packages/shared/
  aws.ts                      the only file that knows about AWS_ENDPOINT_URL
  tenant-context.ts           the isolation chokepoint — cannot exist without a tenant id
  task-repository.ts          tenant-scoped data access; no method takes a tenant id
  tenant-credentials.ts       STS session policies scoped by dynamodb:LeadingKeys
  placement.ts                pure tenant→cell placement + per-tier rate budgets
  rate-limiter.ts             DynamoDB token bucket, two atomic conditional writes
  cell-directory.ts           runtime cell discovery via SSM
  faults.ts                   reads the per-cell chaos switch
  metrics.ts                  per-minute metric buckets, written cell-locally
  concurrency.ts              client-side guardrail for LocalStack's container limit

packages/services/
  router/                     routing lookup + throttle + forward (proxy | redirect)
  api/                        cell data plane: create / get / list tasks
  worker/                     SQS consumer with partial-batch failure reporting
  admin/                      onboarding, cell sync, migration control, overview
  migration/                  the seven migration steps + rollback

tools/                        smoke, seed, tenant, chaos, loadgen, migrate, dashboard
test/unit/                    placement, tenant context, session policy
test/integration/             routing, isolation, async, blast radius, noisy neighbour, migration
dashboard/index.html          2s-polling live view
```

---

## 6. Bugs these tests caught

Both are left documented in the code, because the failure modes are the
instructive part.

**The rate limiter failed open under load.** The original optimistic-locking
design was defeated by exactly the burst it existed to shed — see §2 above and
the comment block in `packages/shared/rate-limiter.ts`.

**Migration rollback left 191 orphaned rows.** Rollback correctly restored
routing, but its target-cleanup was gated on a `sourceCellId` field that the
rollback payload did not carry (removed earlier to avoid a Step Functions
missing-path error). The guard was therefore always false, and a "successful"
rollback silently left a full copy of the tenant's data in the target cell. The
cleanup is now unconditional — it needs only the target, and an empty query is a
no-op when nothing was copied.
