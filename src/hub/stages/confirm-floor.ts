import type { Middleware } from '../executor.js';
import { errorResult } from '../result.js';

/**
 * The `confirm` slot until the security layer fills it: actions that declare
 * `requiresConfirmation` (and calls the risk check marks `mustConfirm`) never run unconfirmed, so a
 * hub without a way to ask the user refuses them instead of running them silently. The security
 * layer's confirm stage replaces this and must keep the same floor (access rules cannot turn the
 * confirmation off).
 */
export const confirmFloorStage: Middleware = async (call, next) => {
  if ((call.action.requiresConfirmation || call.mustConfirm) && !call.preApproved) {
    call.audit.outcome = 'declined';
    return errorResult(
      'This needs the user’s confirmation, and this hub has no way to ask for it yet. Ask the user to do it in the Manyplug web panel.',
      'permission',
    );
  }
  return next();
};
