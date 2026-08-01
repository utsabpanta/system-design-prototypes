# Architecture

Design notes for the cell-based multi-tenant prototype. For how to run it, see
[README.md](./README.md).

**New to this?** Start with §1 — it explains the vocabulary from scratch. If you
already know what cells and control planes are, skip to §2.

1. [Concepts](#1-concepts) — what cells, tenants, and control planes actually are
2. [The shape](#2-the-shape) — how this system is wired
3. [Design decisions](#3-design-decisions) — why, and what was rejected
4. [Tenant migration](#4-tenant-migration) — moving a live tenant between cells
5. [What's different from real AWS](#5-whats-different-from-real-aws)
6. [Repository layout](#6-repository-layout)
7. [Bugs these tests caught](#7-bugs-these-tests-caught)

---

## 1. Concepts

### The problem cell-based architecture solves

Start with the ordinary way to build a service: one fleet of servers, one
database, every customer sharing it.

```
   all customers ──► one big service ──► one big database
```

This works well until something goes wrong. When it does, it goes wrong for
*everyone at once*: a bad deploy, a poison message, a runaway query, a corrupted
cache entry, one customer's traffic spike. The **blast radius** — the set of
users affected by a single failure — is 100% of them.

You can improve reliability at the margins (better tests, canary deploys,
autoscaling), but you cannot change the shape of the failure. A single shared
system has a single fate.

**Cell-based architecture changes the shape.** Instead of one big system, you run
several complete, independent copies of it, and assign each customer to one:

```
   customers A,B,C ──► cell-1 (own compute, own database, own queue)
   customers D,E,F ──► cell-2 (own compute, own database, own queue)
   customers G,H   ──► cell-3 (own compute, own database, own queue)
```

Now the same failure takes out one cell. If a customer is in cell-2 and cell-1
dies, they genuinely do not notice — not because cell-1 failed gracefully, but
because *they were never touching cell-1 at all*. With three cells, the blast
radius of one failure is roughly a third of your customers. With ten, a tenth.

That is the entire idea. Everything else is detail about how to do it without
accidentally reintroducing something shared.

> This is the property [`test/integration/blast-radius.test.ts`](./test/integration/blast-radius.test.ts)
> asserts: break one cell, then prove every other cell still serves 100% of its
> requests. If cells ever grow a shared component, that test goes red.

### Cell

A **cell** is one complete, self-sufficient copy of your service — everything a
request needs, end to end. In this prototype a cell is an API Gateway, a Lambda,
a DynamoDB table, an SQS queue, a worker Lambda, and its own metrics table, all
in one CloudFormation stack ([`infra/lib/cell-stack.ts`](./infra/lib/cell-stack.ts)).

Two properties make a cell a cell rather than just a deployment:

1. **Self-sufficient.** A request is served entirely inside one cell. No cell
   calls another cell, and no cell depends on a shared database.
2. **Independently deployable.** You can deploy, break, or delete one cell
   without touching the others.

Cells are also **identical by construction** — the same code instantiated N
times, not N hand-maintained environments. That is what lets you argue a change
tested in one cell behaves the same in the rest.

Cells are usually kept deliberately *small*. A bigger cell serves more customers,
which means a bigger blast radius when it fails — so cells have a **capacity**,
and growth is handled by adding cells rather than growing them.

### Tenant

A **tenant** is one customer of your system — a company, an organisation, an
account. "Multi-tenant" means many tenants share the same infrastructure, which
is what makes SaaS economics work: you do not spin up a private copy of your
stack for every signup.

The catch is that tenants must never see each other's data, and one tenant must
never be able to degrade another's experience. Most of the difficulty in
multi-tenant systems is enforcing those two things.

In this prototype tenants are `acme`, `globex`, `bigco`, and so on
([`tools/seed.ts`](./tools/seed.ts)), identified by an `x-tenant-id` header.

### Data plane and control plane

A useful split, borrowed from networking:

| | **Data plane** | **Control plane** |
|---|---|---|
| Does what | Serves actual user traffic | Manages the system itself |
| Here | the cells | tenant records, the tenant→cell map, placement, migration |
| Request rate | high — every user request | low — onboarding, admin, deploys |
| If it goes down | users are affected immediately | running traffic is fine; you just cannot make changes |

The critical rule: **the data plane must not depend on the control plane to keep
serving.** If onboarding new tenants breaks, existing tenants should not notice.
A cell that has to phone home on every request has made the control plane a
shared dependency — and thereby recreated the single point of failure that cells
were supposed to eliminate.

This prototype respects that in two visible ways: cells discover each other
through SSM at startup rather than calling the control plane per request, and
metrics are *pulled* from cells by the dashboard rather than pushed by cells into
shared storage (§3, "Cells own their telemetry").

The one exception is the router, discussed next.

### Cell router

Something has to answer "which cell serves this tenant?" That is the **cell
router** ([`packages/services/router/index.ts`](./packages/services/router/index.ts)).

It is the one component every request passes through, which makes it the most
dangerous piece of the design: a fat, stateful, business-logic-laden router is a
shared component, and a shared component is the thing cells exist to avoid. So
routers are kept deliberately dumb. This one does exactly three things — look up
the tenant's cell (from a 5-second cache), check the tenant's rate limit, and
forward the request. It holds no business logic and never touches a cell's
database.

On real AWS this job is often done by DNS (Route 53) or a load balancer rather
than by code, which removes it from the request path almost entirely. See §5 for
why this prototype uses a Lambda instead.

### Tenant isolation: pooled, silo, and bridge

How much do tenants actually share? Three standard answers:

| Model | What it means | Upside | Downside |
|---|---|---|---|
| **Pooled** | Tenants share infrastructure; separated by a tenant id on every row | Cheap, efficient, easy to operate | Isolation depends entirely on correct code and correct IAM |
| **Silo** | Each tenant gets dedicated infrastructure | Strongest isolation; noisy neighbours impossible | Expensive; does not scale to thousands of tenants |
| **Bridge** | Both — pooled by default, silo for tenants who need it | Matches cost to requirement | Two paths to build and maintain |

This prototype implements **bridge** (also called tiered): `standard` tenants
share a pooled cell, partitioned by `pk = TENANT#<id>`; `premium` tenants get a
silo cell to themselves. Placement logic lives in
[`packages/shared/placement.ts`](./packages/shared/placement.ts).

Note that a *cell* and a *silo* are different ideas that are easy to conflate.
Cells limit blast radius for everyone. A silo cell is just a cell whose capacity
happens to be one tenant.

### Noisy neighbour

The failure mode where one tenant's *success* hurts everyone sharing its
infrastructure: they discover a for-loop, send 50× their usual traffic, and
consume the capacity their co-tenants needed.

Note this is the opposite of the blast-radius problem. Cells contain a tenant
being *broken*; they do not contain a tenant being *too popular*, because a
greedy tenant inside a cell is using that cell's legitimate capacity. You need a
second mechanism — a per-tenant rate limit
([`packages/shared/rate-limiter.ts`](./packages/shared/rate-limiter.ts)) — so the
abuser absorbs its own throttling.

### Bulkhead

From ship design: a hull divided into sealed compartments so one breach floods
one compartment instead of sinking the vessel. In software it means any hard
partition of a shared resource.

This prototype has two: the cell boundary itself, and per-cell **reserved
concurrency**, so one cell saturating under load cannot consume the whole
account's Lambda capacity and starve its siblings.

### Placement and capacity

**Placement** is choosing which cell a new tenant goes into. This prototype picks
the least-loaded eligible cell, and — importantly — **refuses to overfill**. When
every cell is at capacity, onboarding fails with `507` and a message telling you
to deploy another cell.

That refusal is a feature, not an oversight. Silently exceeding capacity grows
the blast radius of the cell you overfilled, quietly erasing the property you
built the whole architecture to get. Try it: `pnpm run tenant add newco --tier premium`.

### Tenant migration

Moving a live tenant from one cell to another, without losing data and ideally
without downtime. You need it to rebalance a hot cell, to drain a cell before
retiring it, or to move a tenant who upgraded from pooled to silo.

Migration is the reason this system stores an **explicit** tenant→cell mapping
instead of computing one with `hash(tenantId) % cellCount`. A hash needs no
state, but relocating a single tenant under a hash means changing the hash, which
relocates *everybody*. §4 walks through the migration workflow step by step.

### Putting the vocabulary together

> A **tenant** is a customer. Tenants are assigned to **cells** — complete,
> independent copies of the **data plane** — by a **control plane**, whose
> **placement** logic respects each cell's **capacity**. A thin **cell router**
> sends each request to its tenant's cell. Because cells share nothing, a
> failure's **blast radius** is one cell. Because tenants inside a pooled cell
> *do* share, a **rate limit** stops **noisy neighbours**, **bulkheads** stop one
> cell starving another, and **silo** cells exist for tenants who need physical
> separation. **Migration** moves a tenant between cells when the assignment
> needs to change.

### Where to read more

- [AWS Well-Architected: Reducing scope of impact with cell-based architecture](https://docs.aws.amazon.com/wellarchitected/latest/reducing-scope-of-impact-with-cell-based-architecture/)
- [AWS SaaS Lens: tenant isolation strategies](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/)
- [Shuffle sharding](https://aws.amazon.com/builders-library/workload-isolation-using-shuffle-sharding/) — a refinement where tenants get overlapping *combinations* of cells, so no two tenants share exactly the same fate. Not implemented here, but the natural next step.

---

## 2. The shape

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

## 3. Design decisions

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

## 4. Tenant migration

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

## 5. What's different from real AWS

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

## 6. Repository layout

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

## 7. Bugs these tests caught

Both are left documented in the code, because the failure modes are the
instructive part.

**The rate limiter failed open under load.** The original optimistic-locking
design was defeated by exactly the burst it existed to shed — see §3 above and
the comment block in `packages/shared/rate-limiter.ts`.

**Migration rollback left 191 orphaned rows.** Rollback correctly restored
routing, but its target-cleanup was gated on a `sourceCellId` field that the
rollback payload did not carry (removed earlier to avoid a Step Functions
missing-path error). The guard was therefore always false, and a "successful"
rollback silently left a full copy of the tenant's data in the target cell. The
cleanup is now unconditional — it needs only the target, and an empty query is a
no-op when nothing was copied.
