import type { CustomServiceManager } from '../core/custom-services.js';
import type { AccountHealthService } from '../core/health.js';
import type { StatusService } from '../ops/status.js';
import type { JobDefinition } from './queue.js';

/** Jobs every hub runs. New recurring work is added here (or registered by a feature module). */
export function builtinJobs(deps: {
  health: AccountHealthService;
  customServices: CustomServiceManager;
  status: StatusService;
}): JobDefinition[] {
  return [
    {
      name: 'status.sample',
      description: 'Record the status page sample of this minute',
      cron: '* * * * *',
      expectEveryMs: 10 * 60_000,
      run: async () => {
        await deps.status.sample();
      },
    },
    {
      name: 'accounts.refresh_tokens',
      description: 'Refresh OAuth tokens that expire within 15 minutes',
      cron: '*/5 * * * *',
      expectEveryMs: 20 * 60_000,
      run: async () => {
        await deps.health.refreshExpiringTokens();
      },
    },
    {
      name: 'accounts.health_check',
      description: 'Re-run the connection test of accounts not checked for a day',
      cron: '17 * * * *',
      expectEveryMs: 3 * 3_600_000,
      run: async () => {
        await deps.health.checkStaleAccounts();
      },
    },
    {
      name: 'services.refresh_tools',
      description: 'Re-read the tool lists of remote MCP servers',
      cron: '41 4 * * *',
      expectEveryMs: 50 * 3_600_000,
      run: async () => {
        await deps.customServices.refreshAll();
      },
    },
  ];
}
