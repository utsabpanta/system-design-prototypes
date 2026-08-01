# Cell-Based Multi-Tenant Architecture — a runnable prototype

A working multi-tenant system built the way it would be built on AWS — real CDK,
real CloudFormation, real AWS APIs — but deployed entirely to LocalStack on a laptop.

The point is not the task API it happens to serve. The point is that the properties
usually asserted in design docs are things you can **trigger and watch**:

| Claim | How to see it |
|---|---|
| A failing cell doesn't take down other cells | `npm run chaos -- set cell-a error`, then watch the other cells keep serving |
| One tenant can't starve its neighbours | `npm run load -- --scenario noisy-neighbor` |
| A tenant's data is unreachable to co-tenants | `npm test` → `isolation.test.ts` |
| A live tenant can be moved between cells | `npm run migrate -- --tenant acme --to cell-b` |
| A failed migration leaves no trace | `npm run migrate -- --tenant acme --to cell-b --fail-after-copy` |

---

## Quick start

Requires Docker Desktop running, Node 22+, and ~4 GB free RAM.

```bash
npm install
npm run up          # start LocalStack, wait for health
npm run smoke       # verify which AWS services this LocalStack tier supports
npm run bootstrap   # cdk bootstrap (once per LocalStack lifetime)
npm run deploy      # deploy ControlPlane + 3 cells
npm run seed        # onboard 9 tenants across the cells
npm test            # 47 tests, ~3 min
npm run dash        # http://localhost:4000
```

`npm run reset` wipes LocalStack and starts clean — needed after a restart, since
state persistence is a LocalStack Pro feature.

---

## Architecture

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

### Design decisions worth knowing

**Cells are independent CloudFormation stacks.** `infra/lib/cell-stack.ts` is
instantiated once per entry in `infra/lib/cells.config.ts`. There are no
CloudFormation exports between cells and no imports from the control plane, so
`cdklocal deploy Cell-a` provably cannot touch Cell-b. Discovery happens at
*runtime* through SSM (`packages/shared/cell-directory.ts`) rather than at synth
time, specifically to preserve that independence.

**Routing is an explicit stored mapping, not a hash.** A `hash(tenantId) % N`
router needs no state, but it makes silo placement impossible and migration
require rehashing everyone. One row per tenant in `cp-routing` costs a cached
lookup per request and buys both.

**Tiered ("bridge") isolation.** Standard tenants share a pooled cell's table,
partitioned by `pk = TENANT#<id>`. Premium tenants get a silo cell to themselves.
`packages/shared/placement.ts` decides, and refuses to overfill — "deploy another
cell" is the intended answer to growth, so silently exceeding capacity would erase
the property being bought.

**Isolation is enforced in two layers.**
1. *Structural*: `TaskRepository` (`packages/shared/task-repository.ts`) is
   constructed from a `TenantContext` and no method takes a tenant id — a handler
   holding tenant A's repository has no expressible way to read tenant B.
2. *IAM*: before touching data, the api Lambda re-assumes its role with a session
   policy scoped by `dynamodb:LeadingKeys` (`tenant-credentials.ts`), so even a
   hand-built foreign key is denied. **LocalStack's free tier does not reliably
   evaluate session policies**, so locally this layer is present but not enforced;
   the generated policy is unit-tested instead.

**Cells own their telemetry.** Metrics live in each cell's own DynamoDB table and
the control plane *pulls* them when the dashboard asks. Cells never push. A cell
must not depend on the control plane to serve traffic, and a wedged control plane
must not become a cross-cell failure.

**The rate limiter is two atomic conditional writes, not read-modify-write.**
The obvious optimistic-locking version was built first and measurably failed: at
30 concurrent requests nearly all lost the version race, exhausted their retries,
and were waved through — a limiter defeated by exactly the burst it exists to stop.
See the comment block in `packages/shared/rate-limiter.ts`.

---

## What's different from real AWS

Everything here is a consequence of the free LocalStack tier or of a laptop.
Nothing in this list is a property of the architecture.

| Area | This prototype | Real AWS | Why |
|---|---|---|---|
| Cell routing | API Gateway + Lambda router | Route 53 latency/weighted records, or ALB, or CloudFront + Lambda@Edge | ALB and Route 53 hosted zones are not in the free tier |
| Cell entry | API Gateway **REST (v1)** | HTTP API (v2) — cheaper, faster | `apigatewayv2` is Pro-only; `npm run smoke` confirms this every run |
| Compute | Lambda only | ECS/Fargate for long-lived services is often the better cell shape | No ECS in the free tier |
| Relational data | DynamoDB only | RDS/Aurora per cell is common for silo tenants | No RDS in the free tier |
| Identity | `x-tenant-id` header, trusted from the router | Cognito / OIDC + a Lambda authorizer producing verified claims | No Cognito in the free tier. **The header is unauthenticated — this is a prototype, not a security model** |
| IAM enforcement | Session policies generated but not enforced | Actually enforced | Free-tier limitation; try `ENFORCE_IAM=1` in `docker-compose.yml` |
| Concurrency | ~12 concurrent requests max | Effectively unbounded | LocalStack runs **one Docker container per Lambda invocation**. A 25-wide burst reproducibly wedges it. See `packages/shared/concurrency.ts` |
| Rate limits | standard 2 rps / premium 50 rps | hundreds to thousands | A realistic limit could never be reached locally, making throttling unobservable |
| Regions | Single region | Cells usually span AZs, sometimes regions | Single LocalStack instance |
| State | Lost on restart | Durable | Persistence is a Pro feature; `npm run reset` re-creates everything |

**Portability.** Every AWS client reads `AWS_ENDPOINT_URL` from one place
(`packages/shared/aws.ts`) and omits it when unset. `tools/with-local-env.sh` is the
only thing that sets it. Drop that wrapper and `cdk deploy` targets a real account —
though you would want to revisit the routing layer and rate limits first.

---

## Repository layout

```
infra/
  bin/app.ts                 CDK app: ControlPlaneStack + CellStack × N
  lib/cells.config.ts        the cell inventory — the only place cell count lives
  lib/cell-stack.ts          one cell: API, compute, table, queue, metrics, chaos knob
  lib/control-plane-stack.ts routing/tenant/cell tables, router, admin API, migration SFN
packages/
  shared/                    tenant context, scoped repository, placement, limiter,
                             faults, metrics, cell directory, concurrency guardrail
  services/
    router/                  routing lookup + throttle + forward (proxy | redirect)
    api/                     cell data plane: create / get / list tasks
    worker/                  SQS consumer with partial-batch failure reporting
    admin/                   onboarding, cell sync, migration control, overview
    migration/               the seven migration steps + rollback
tools/                       smoke, seed, chaos, loadgen, migrate, dashboard server
test/unit/                   placement, tenant context, session policy
test/integration/            routing, isolation, async, blast radius, noisy neighbour, migration
dashboard/index.html         2s-polling live view
```

---

## Exercises

Run `npm run dash` in one terminal and work through these in another.

**1. Blast radius.** `npm run chaos -- set cell-a error`, then
`npm run load -- --scenario baseline --duration 20`. The report's failures-by-cell
line should name only cell-a. `npm run chaos -- clear-all` when done.

**2. Latency containment.** `npm run chaos -- set cell-b latency`. Only cell-b's
p95 moves. This is the failure mode that leaks across a shared thread pool but
cannot cross a cell boundary.

**3. Noisy neighbour.** `npm run load -- --scenario noisy-neighbor`. One tenant
absorbs its own 429s while its *co-tenant in the same cell* stays clean.

**4. Live migration.** `npm run migrate -- --tenant acme --to cell-b` while the
baseline load is running. Watch the tenant move on the dashboard; reads never stop.

**5. Rollback.** `npm run migrate -- --tenant acme --to cell-a --fail-after-copy`.
The tenant stays put and the partial copy is deleted.

**6. Capacity exhaustion.** `npm run tenant -- add newco --tier premium`.
The silo cell holds exactly one tenant, so this fails with `507 no_capacity` and a
message telling you to deploy another cell. That refusal is the design working:
overfilling a cell would silently erase the isolation the tier was sold on.
`npm run tenant -- list` shows occupancy per cell.

**7. Add a cell.** Add `{ id: 'cell-d', tier: 'pooled', capacity: 5, reservedConcurrency: 6 }`
to `infra/lib/cells.config.ts`, then `npm run deploy && npm run seed`. Note that no
existing cell is modified and no tenant moves.

---

## Commands

| Command | What it does |
|---|---|
| `npm run up` / `down` / `reset` | LocalStack lifecycle |
| `npm run smoke` | Verify AWS service coverage on this tier |
| `npm run deploy` | Deploy all stacks |
| `npm run deploy:cell -- Cell-a` | Deploy one cell (the fast inner loop) |
| `npm run seed` | Onboard tenants; also reconciles tier rate limits |
| `npm run tenant -- list \| add <id> [--tier premium] \| show <id>` | Inspect and onboard tenants |
| `npm test` | Full suite (47 tests, ~3 min) |
| `npm run test:slow` | SQS redrive to DLQ (~3.5 min — see below) |
| `npm run chaos -- status \| set <cell> <mode> \| clear-all` | Fault injection |
| `npm run load -- --scenario <name> --duration <s>` | baseline · noisy-neighbor · cell-failure |
| `npm run migrate -- --tenant <id> --to <cell> [--fail-after-copy]` | Move a tenant |
| `npm run dash` | Dashboard on :4000 |

Fault modes: `none`, `latency` (+1.5s), `error` (5xx), `blackhole` (hangs).

---

## Notes on the tests

47 tests run in about three minutes. They run **single-forked and serially** —
LocalStack's one-container-per-invocation model turns test parallelism directly
into container concurrency, and a parallel suite wedges the emulator.

`test/integration/dlq.slow.test.ts` is excluded from `npm test`. Redrive to the DLQ
takes ~209 seconds (measured): three redeliveries at a 35s visibility timeout plus
LocalStack's own SQS poller backoff. The behaviour matters — without a DLQ a poison
message is redelivered forever and permanently consumes part of a cell's worker
capacity — so it is kept as an opt-in `npm run test:slow` rather than deleted or
weakened.

Two bugs found by these tests, both left documented in the code because the failure
modes are instructive:
- the rate limiter's original read-modify-write design, which failed open under
  exactly the load it was meant to shed;
- migration rollback restoring routing but leaving 191 orphaned rows in the target
  cell, because the cleanup was gated on a field the rollback payload didn't carry.
