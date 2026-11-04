import { ensureAdmin } from './core/identity.js';
import { runMigrations } from './db/migrate.js';
import type { Services } from './services.js';

/** Startup tasks: migrations, the bootstrap owner, and demo accounts for a brand-new workspace. */
export async function bootstrap(services: Services): Promise<void> {
  const { config, logger, database, db, accounts } = services;
  if (config.migrateOnStart) {
    await runMigrations(database.pool);
    logger.info('database migrations applied');
  }
  if (services.secrets.usingDevelopmentKey) {
    logger.warn('ENCRYPTION_KEY is not set: using an insecure development key. Never do this in production.');
  }
  const encryption = await accounts.upgradeEncryption();
  if (encryption.upgraded || encryption.rewrapped) {
    logger.info(encryption, 'account encryption upgraded');
  }
  const oauthTokens = await services.tokens.upgradeEncryption();
  if (oauthTokens.upgraded) logger.info(oauthTokens, 'account OAuth tokens moved to account keys');
  if (encryption.failed || oauthTokens.failed) {
    logger.error(
      { failed: encryption.failed + oauthTokens.failed },
      'some account secrets cannot be decrypted with the configured keys (check ENCRYPTION_KEYS_PREVIOUS)',
    );
  }
  await setupTelegram(services);
  const linked = await services.aiClients.backfill();
  if (linked.grants || linked.tokens) logger.info(linked, 'existing AI apps linked to AI clients');
  if (!config.admin) {
    logger.warn('ADMIN_EMAIL / ADMIN_PASSWORD are not set: nobody can sign in until they are.');
    return;
  }
  const result = await ensureAdmin(db, config.admin);
  if (result.created) logger.info({ email: result.user.email }, 'owner account created');
  if (result.passwordUpdated)
    logger.info({ email: result.user.email }, 'owner password updated from ADMIN_PASSWORD');
  if (result.created && config.seedDemoAccounts) {
    await accounts.create(result.workspace.id, {
      connectorId: 'demo',
      name: 'main',
      label: 'Demo — main',
      description: 'First test account',
      config: { greeting: 'Hello' },
      credentials: { secret: 'demo-secret-main' },
    });
    await accounts.create(result.workspace.id, {
      connectorId: 'demo',
      name: 'second',
      label: 'Demo — second',
      description: 'Second test account, shows multi-account routing',
      config: { greeting: 'Привет' },
      credentials: { secret: 'demo-secret-second' },
    });
    logger.info('demo accounts created');
  }
}

/** Points the hub's Telegram bot at our webhook (Telegram only delivers to https URLs). */
async function setupTelegram(services: Services): Promise<void> {
  const { telegramBot: bot, config, logger } = services;
  if (!bot) return;
  if (!config.publicUrl.startsWith('https://')) {
    logger.warn(
      'TELEGRAM_BOT_TOKEN is set but PUBLIC_URL is not https: Telegram confirmations are disabled.',
    );
    return;
  }
  try {
    await bot.setWebhook(`${config.publicUrl}/telegram/webhook`, services.telegramWebhookSecret);
    logger.info({ bot: await bot.getUsername() }, 'telegram bot connected');
  } catch (error) {
    logger.error({ err: error }, 'telegram webhook setup failed; confirmations still work on the web page');
  }
}
