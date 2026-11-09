import type { Db } from '../../db/client.js';
import type { CircuitBreaker } from '../../lib/circuit-breaker.js';
import type { RateLimiter } from '../../lib/rate-limit.js';
import type { Logger } from '../../logger.js';
import type { StageMap } from '../executor.js';
import type { IdempotencyStore } from '../idempotency.js';
import type { QuotaGate } from '../quota.js';
import type { UsageMeter } from '../usage.js';
import { auditStage } from './audit.js';
import { automationStage } from './automation.js';
import { circuitStage } from './circuit.js';
import { confirmFloorStage } from './confirm-floor.js';
import { idempotencyStage } from './idempotency.js';
import { identityStage } from './identity.js';
import { limitsStage } from './limits.js';
import { meterStage } from './meter.js';
import { quotaStage } from './quota.js';
import { riskStage } from './risk.js';
import { shapeStage } from './shape.js';

export { recordToolCall } from './audit.js';

/**
 * The hub's built-in stages. `policy`, `confirm` and `untrusted` are slots for the security layer
 * (via `createServices({ stages })`): `policy` and `untrusted` pass calls through until then, and
 * `confirm` refuses actions that always need the user's confirmation.
 */
export function defaultStages(deps: {
  db: Db;
  logger: Logger;
  rateLimiter: RateLimiter;
  circuitBreaker?: CircuitBreaker;
  idempotency: IdempotencyStore;
  idempotencyWindowMs: number;
  maxResultTokens: number;
  meter?: UsageMeter;
  quota?: QuotaGate;
  /** Stores an identity the `identity` stage found (see `AccountService.setIdentity`). */
  setIdentity?: (accountId: string, identity: string) => Promise<void>;
}): StageMap {
  return {
    audit: auditStage(deps),
    ...(deps.meter
      ? {
          meter: meterStage({
            meter: deps.meter,
            logger: deps.logger,
            ...(deps.quota?.payerOf ? { payer: (p) => deps.quota!.payerOf!(p) } : {}),
          }),
        }
      : {}),
    ...(deps.quota ? { quota: quotaStage(deps.quota) } : {}),
    risk: riskStage,
    automation: automationStage,
    confirm: confirmFloorStage,
    limits: limitsStage({ rateLimiter: deps.rateLimiter }),
    ...(deps.circuitBreaker ? { circuit: circuitStage(deps.circuitBreaker) } : {}),
    ...(deps.setIdentity ? { identity: identityStage({ setIdentity: deps.setIdentity }) } : {}),
    idempotency: idempotencyStage({ store: deps.idempotency, windowMs: deps.idempotencyWindowMs }),
    shape: shapeStage(deps),
  };
}
