import type { Db } from '../../db/client.js';
import type { RateLimiter } from '../../lib/rate-limit.js';
import type { Logger } from '../../logger.js';
import type { StageMap } from '../executor.js';
import type { IdempotencyStore } from '../idempotency.js';
import { auditStage } from './audit.js';
import { idempotencyStage } from './idempotency.js';
import { limitsStage } from './limits.js';
import { riskStage } from './risk.js';
import { shapeStage } from './shape.js';

export { recordToolCall } from './audit.js';

/**
 * The hub's built-in stages. `policy`, `confirm` and `untrusted` are slots: they pass calls through
 * until the security layer provides them (via `createServices({ stages })`).
 */
export function defaultStages(deps: {
  db: Db;
  logger: Logger;
  rateLimiter: RateLimiter;
  idempotency: IdempotencyStore;
  idempotencyWindowMs: number;
  maxResultTokens: number;
}): StageMap {
  return {
    audit: auditStage(deps),
    risk: riskStage,
    limits: limitsStage({ rateLimiter: deps.rateLimiter }),
    idempotency: idempotencyStage({ store: deps.idempotency, windowMs: deps.idempotencyWindowMs }),
    shape: shapeStage(deps),
  };
}
