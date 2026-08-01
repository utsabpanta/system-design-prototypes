# Cell-Based Multi-Tenant Architecture — a runnable prototype

A working multi-tenant system built the way it would be built on AWS — real CDK,
real CloudFormation, real AWS APIs — but deployed entirely to **LocalStack on your
laptop**. No AWS account, no cloud spend.

The point is not the task API it happens to serve. The point is that properties
usually asserted in design docs are things you can **trigger and watch**:

| Claim | How to see it |
|---|---|
| A failing cell doesn't take down other cells | `pnpm run chaos set cell-a error` |
| One tenant can't starve its neighbours | `pnpm run load --scenario noisy-neighbor` |
| A tenant's data is unreachable to co-tenants | `pnpm test` → `isolation.test.ts` |
| A live tenant can be moved between cells | `pnpm run migrate --tenant acme --to cell-b` |
| A failed migration leaves no trace | add `--fail-after-copy` to the above |

### New to cell-based architecture?

Read **[ARCHITECTURE.md §1 — Concepts](./ARCHITECTURE.md#1-concepts)** first. It
explains the vocabulary from scratch — what a *cell* is, what a *tenant* is, the
difference between the *control plane* and the *data plane*, and what problem the
whole pattern exists to solve — with each term linked to the file that implements
it here.

The one-paragraph version: instead of running one big system that every customer
shares, you run several complete independent copies of it (**cells**) and assign
each customer (**tenant**) to one. When something breaks, it breaks one cell
instead of everyone — the **blast radius** of a failure is bounded by design
rather than by hope. The rest is detail about doing that without accidentally
reintroducing something shared.

📐 The rest of **[ARCHITECTURE.md](./ARCHITECTURE.md)** covers the design, the
trade-offs, and an honest table of how this differs from real AWS.

---

## Prerequisites

| Requirement | Check | If missing |
|---|---|---|
| **Docker Desktop, running** | `docker info` | [Install](https://docs.docker.com/desktop/) and launch it. The whale icon must be steady, not animating |
| **Node 22+** | `node --version` | [nodejs.org](https://nodejs.org) or `nvm install 22` |
| **pnpm 10+** | `pnpm --version` | `corepack enable && corepack prepare pnpm@latest --activate` |
| **~4 GB free RAM** | — | LocalStack runs each Lambda as its own container |
| **~2 GB disk** | `df -h .` | For the LocalStack image and Docker layers |

You do **not** need an AWS account, AWS credentials, or the AWS CLI. Credentials
are dummy values injected by `tools/with-local-env.sh`.

---

## Run it

Five commands from a clean checkout. Total time: about 5 minutes, most of it the
first Docker image pull.

```bash
# 1. install dependencies
pnpm install

# 2. start LocalStack and wait until it is healthy   (~30s first time: image pull)
pnpm run up

# 3. confirm which AWS services this LocalStack tier supports  (~15s)
pnpm run smoke

# 4. prepare CDK, then deploy the control plane + 3 cells      (~90s)
pnpm run bootstrap
pnpm run deploy

# 5. onboard 9 tenants across the cells                        (~20s)
pnpm run seed
```

Expected output from step 5:

```
tenant placement:
  acme       standard  -> cell-a
  globex     standard  -> cell-b
  ...
  bigco      premium   -> cell-c

cell occupancy:
  cell-a   4/5 tenants (pooled)
  cell-b   4/5 tenants (pooled)
  cell-c   1/1 tenants (silo)
```

### Verify it works

```bash
pnpm test        # 47 tests, ~3 minutes
```

All 7 files should pass. This is the real acceptance gate — it covers routing,
tenant isolation, the async path, blast-radius containment, noisy-neighbour
throttling, and live migration with rollback.

### Watch it

```bash
pnpm run dash    # → http://localhost:4000
```

A live cell grid that polls every 2 seconds. Leave it open in one terminal and
run the exercises below in another.

> **Use `pnpm run <script>`, not `pnpm <script>`.** `pnpm up` is a built-in alias
> for `pnpm update` and would update your dependencies instead of starting
> LocalStack. The explicit `run` form always does the right thing.

---

## Try it by hand

LocalStack assigns new API Gateway ids on every reset, so grab the current URLs:

```bash
pnpm run urls                                  # show them
eval "$(pnpm run --silent urls --export)"      # sets $ROUTER and $ADMIN
```

```bash
# create a task
curl -X POST "$ROUTER/v1/tasks" \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: acme' \
  -d '{"kind":"report","payload":{"n":1}}' -i

# note the x-cell-id header in the response — that's which cell served you

# list the tenant's tasks
curl "$ROUTER/v1/tasks?limit=5" -H 'x-tenant-id: acme'

# a different tenant cannot see acme's task, even sharing a cell
curl -o /dev/null -w '%{http_code}\n' \
  "$ROUTER/v1/tasks/<paste-a-task-id>" -H 'x-tenant-id: globex'   # → 404

# no tenant header at all
curl -o /dev/null -w '%{http_code}\n' "$ROUTER/v1/tasks"          # → 401
```

`content-type: application/json` matters — without it curl sends form-encoded
and you'll get a `400`.

---

## Exercises

Run `pnpm run dash` in one terminal, these in another.

**1. Blast radius.** Break one cell and confirm the others don't care.
```bash
pnpm run chaos set cell-a error
pnpm run load --scenario baseline --duration 20 --keep-faults
pnpm run chaos clear-all
```
```
BY CELL        sent     ok    429   fail
cell-a           34      0      0     34     ← every request fails
cell-b           34     34      0      0     ← untouched
cell-c           51     51      0      0     ← untouched

failures by cell: cell-a=34
```
`--keep-faults` matters: without it the load generator clears faults at startup
so a stale one can't skew results, and your deliberate fault would go with it.
(`--scenario cell-failure` injects its own fault mid-run and needs no flag.)

**2. Latency containment.** Slowness, not failure — the mode that leaks across a
shared thread pool but cannot cross a cell boundary.
```bash
pnpm run chaos set cell-b latency
pnpm run load --scenario baseline --duration 15 --keep-faults
pnpm run chaos clear-all
```
Only cell-b's p95 moves (~2.5s vs ~1s elsewhere), and nothing errors.

**3. Noisy neighbour.** `pnpm run load --scenario noisy-neighbor`. One tenant
absorbs its own 429s while its **co-tenant in the same cell** stays clean.

**4. Live migration.** With a baseline load running, `pnpm run migrate --tenant
acme --to cell-b`. Watch the tenant move on the dashboard; reads never stop.

**5. Rollback.** `pnpm run migrate --tenant acme --to cell-a --fail-after-copy`.
The tenant stays put and the partial copy is deleted.

**6. Capacity exhaustion.** `pnpm run tenant add newco --tier premium`. The silo
cell holds exactly one tenant, so this fails with `507 no_capacity` telling you
to deploy another cell. That refusal *is* the design — overfilling would erase
the isolation the tier was sold on.

**7. Add a cell.** Append to `infra/lib/cells.config.ts`:
```ts
{ id: 'cell-d', tier: 'pooled', capacity: 5, reservedConcurrency: 6 },
```
then `pnpm run deploy && pnpm run seed`. Note that no existing cell is modified
and no tenant moves.

---

## Commands

| Command | What it does |
|---|---|
| `pnpm run up` / `down` / `reset` | LocalStack lifecycle (`reset` wipes all state) |
| `pnpm run smoke` | Verify AWS service coverage on this LocalStack tier |
| `pnpm run bootstrap` | CDK bootstrap — once per LocalStack lifetime |
| `pnpm run deploy` | Deploy all 4 stacks |
| `pnpm run deploy:cell Cell-a` | Deploy one stack — the fast inner loop |
| `pnpm run seed` | Onboard tenants; also reconciles tier rate limits |
| `pnpm run urls [--export]` | Print router / admin / cell endpoints |
| `pnpm run tenant list \| add <id> [--tier premium] \| show <id>` | Inspect and onboard tenants |
| `pnpm test` | Full suite (47 tests, ~3 min) |
| `pnpm run test:slow` | SQS redrive to DLQ (~3.5 min, opt-in — see below) |
| `pnpm run typecheck` | `tsc --noEmit` |
| `pnpm run chaos status \| set <cell> <mode> \| clear <cell> \| clear-all` | Fault injection |
| `pnpm run load --scenario <name> --duration <s> [--keep-faults]` | `baseline` · `noisy-neighbor` · `cell-failure` |
| `pnpm run migrate --tenant <id> --to <cell> [--fail-after-copy]` | Move a tenant |
| `pnpm run dash` | Dashboard on :4000 |

Fault modes: `none`, `latency` (+1.5s), `error` (5xx), `blackhole` (hangs).

---

## Troubleshooting

**`Cannot connect to the Docker daemon`** — Docker Desktop isn't running. Start it
and wait for the whale icon to stop animating.

**LocalStack stops responding mid-run; `curl localhost:4566` hangs.** You
overloaded it. LocalStack runs one Docker container per Lambda invocation, and a
burst above ~25 wedges the whole instance. Recover with:
```bash
docker compose down
docker ps -aq --filter "name=localstack-" | xargs -r docker rm -f
pnpm run reset
pnpm run bootstrap && pnpm run deploy && pnpm run seed
```
To avoid it, keep client fan-out under `LOCAL_SAFE_CONCURRENCY` (default 8) — the
tools already do this; see `packages/shared/concurrency.ts`.

**Everything 404s / `SSM parameter is empty` after restarting your machine.**
LocalStack state does not persist (that's a Pro feature). Re-run:
```bash
pnpm run up && pnpm run bootstrap && pnpm run deploy && pnpm run seed
```

**`pnpm up` updated my dependencies.** That's pnpm's built-in `update` alias.
Use `pnpm run up`. (`git checkout pnpm-lock.yaml && pnpm install` to undo.)

**`EnvironmentMisconfigurationError: AWS_ENDPOINT_URL_S3 must be specified`** —
you invoked `cdklocal` directly instead of through a script. Use `pnpm run deploy`,
or wrap it: `bash tools/with-local-env.sh cdklocal <cmd>`.

**A test fails on a fresh clone but passes on retry.** Some tests are
timing-sensitive against a loaded emulator. If a specific test fails repeatedly,
that's real — open the file, the assertions document what they expect and why.

**Tests are slow.** Expected. They run single-forked and serially on purpose:
LocalStack's one-container-per-invocation model turns test parallelism directly
into container concurrency, and a parallel suite wedges the emulator.

---

## Notes

**Package manager.** pnpm, with `node-linker=hoisted` in `.npmrc`. CDK's
`NodejsFunction` shells out to esbuild and resolves `aws-cdk-lib`'s transitive
deps at synth time, which pnpm's default symlinked layout hides. Hoisting keeps
the CDK toolchain working exactly as it does under npm.

**The slow test.** `test/integration/dlq.slow.test.ts` is excluded from
`pnpm test`. Redrive to the DLQ takes ~209 seconds (measured): three
redeliveries at a 35s visibility timeout plus LocalStack's own SQS poller
backoff. The behaviour matters — without a DLQ a poison message is redelivered
forever and permanently consumes part of a cell's worker capacity — so it's kept
as opt-in rather than deleted or weakened.

**Security.** The `x-tenant-id` header is unauthenticated. On real AWS that would
be a Cognito/OIDC Lambda authorizer producing verified claims. This is a
prototype for studying architecture, not a security model.
