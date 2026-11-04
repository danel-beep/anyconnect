import type { AccountHealthService } from '../core/health.js';
import type { JobDefinition } from './queue.js';

/** Jobs every hub runs. New recurring work is added here (or registered by a feature module). */
export function builtinJobs(deps: { health: AccountHealthService }): JobDefinition[] {
  return [
    {
      name: 'accounts.refresh_tokens',
      description: 'Refresh OAuth tokens that expire within 15 minutes',
      cron: '*/5 * * * *',
      run: async () => {
        await deps.health.refreshExpiringTokens();
      },
    },
    {
      name: 'accounts.health_check',
      description: 'Re-run the connection test of accounts not checked for a day',
      cron: '17 * * * *',
      run: async () => {
        await deps.health.checkStaleAccounts();
      },
    },
  ];
}
