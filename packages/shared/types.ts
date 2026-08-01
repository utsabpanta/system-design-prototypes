/** Shapes shared by the control plane, the router, and every cell. */

/** How a cell is shared. Pooled cells hold many tenants; silo cells hold one. */
export type CellTier = 'pooled' | 'silo';

/** What a tenant paid for. Drives placement and rate limits. */
export type TenantTier = 'standard' | 'premium';

export type TenantStatus =
  | 'ACTIVE'
  /** Migration in flight: reads served, writes rejected with 409. */
  | 'READ_ONLY'
  | 'SUSPENDED';

export type CellStatus = 'ACTIVE' | 'DRAINING' | 'UNHEALTHY';

/** Fault injected into a cell by tools/chaos.ts, read from SSM by cell code. */
export type FaultMode = 'none' | 'latency' | 'error' | 'blackhole';

export interface RateLimit {
  /** Sustained requests per second. */
  rps: number;
  /** Bucket size, i.e. how large a burst is tolerated. */
  burst: number;
}

export interface Tenant {
  tenantId: string;
  name: string;
  tier: TenantTier;
  status: TenantStatus;
  rateLimit: RateLimit;
  createdAt: string;
}

/**
 * The tenant -> cell mapping. Deliberately a stored row rather than
 * hash(tenantId) % cellCount: an explicit mapping is what makes silo placement
 * and live migration possible at all.
 */
export interface RoutingEntry {
  tenantId: string;
  cellId: string;
  /** Set during migration so the router can reject writes without a deploy. */
  status: TenantStatus;
  /** Denormalised onto the routing row so the hot path is a single lookup. */
  tier: TenantTier;
  rateLimit: RateLimit;
  updatedAt: string;
}

export interface CellRecord {
  cellId: string;
  tier: CellTier;
  status: CellStatus;
  /** Maximum tenants the cell will accept — the knob that forces new cells. */
  capacity: number;
  tenantCount: number;
}

/**
 * Written to SSM by each cell stack so the control plane can discover it at
 * runtime. Discovery through SSM rather than CloudFormation exports is what
 * keeps cells free of cross-stack dependencies.
 */
export interface CellRuntimeConfig {
  cellId: string;
  tier: CellTier;
  capacity: number;
  endpoint: string;
  tasksTable: string;
  metricsTable: string;
  queueUrl: string;
}

export type TaskStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface Task {
  tenantId: string;
  taskId: string;
  status: TaskStatus;
  kind: string;
  payload: unknown;
  cellId: string;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
}
