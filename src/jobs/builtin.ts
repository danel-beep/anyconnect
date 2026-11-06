import type { Analytics } from '../analytics/index.js';
import type { AccountAlerts } from '../core/account-alerts.js';
import type { ActivityRetention, ActivityService } from '../core/activity.js';
import type { CustomServiceManager } from '../core/custom-services.js';
import type { AccountHealthService } from '../core/health.js';
import type { BillingNotices } from '../notices/billing-notices.js';
import type { BackupService } from '../ops/backups.js';
import type { StatusService } from '../ops/status.js';
import type { JobDefinition } from './queue.js';

/** Jobs every hub runs. New recurring work is added here (or registered by a feature module). */
export function builtinJobs(deps: {
  health: AccountHealthService;
  alerts: AccountAlerts;
  customServices: CustomServiceManager;
  billingNotices: BillingNotices;
  status: StatusService;
  activity: ActivityService;
  /** How long each workspace keeps its activity log (the plan's `historyDays`). */
  retention: ActivityRetention;
  /** Present when a backup bucket is configured. */
  backups?: BackupService | undefined;
  analytics?: Analytics | undefined;
}): JobDefinition[] {
  const analytics = deps.analytics;
  const backups = deps.backups;
  return [
    ...(backups
      ? [
          {
            name: 'backup.database',
            description: 'Back up the database to the configured bucket',
            cron: '17 3 * * *',
            expectEveryMs: 26 * 3_600_000,
            run: async () => {
              await backups.run();
            },
          },
        ]
      : []),
    ...(analytics?.enabled
      ? [
          {
            name: 'analytics.prune',
            description: 'Forget old visitor salts and analytics past their retention',
            cron: '23 0 * * *',
            expectEveryMs: 26 * 3_600_000,
            run: async () => {
              await analytics.prune();
            },
          },
        ]
      : []),
    {
      name: 'activity.prune',
      description: 'Delete activity log entries older than each plan keeps them',
      cron: '47 1 * * *',
      expectEveryMs: 26 * 3_600_000,
      run: async (_data, ctx) => {
        const { workspaces } = await deps.activity.prune(deps.retention);
        if (workspaces) ctx.logger.info({ workspaces }, 'activity log pruned');
      },
    },
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
      name: 'accounts.notify_reauth',
      description: 'Tell owners about accounts that need a new sign-in',
      cron: '*/5 * * * *',
      expectEveryMs: 20 * 60_000,
      run: async () => {
        await deps.alerts.notifyReauth();
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
    {
      name: 'billing.trial_reminders',
      description: 'Email workspaces whose free Pro trial ends within three days',
      cron: '7 10 * * *',
      run: async (_data, ctx) => {
        const sent = await deps.billingNotices.remindTrialEnding();
        if (sent) ctx.logger.info({ sent }, 'trial reminders sent');
      },
    },
  ];
}
