import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { toAccountView } from '../core/accounts.js';
import { createUser, findUserByEmail, getDefaultWorkspace, setPassword } from '../core/identity.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema.js';
import { generateKey } from '../lib/crypto.js';
import { createLogger } from '../logger.js';
import { createServices, type Services } from '../services.js';

const HELP = `AnyConnect admin CLI

Usage: npm run cli -- <command> [options]

  keys:generate                          Print a new ENCRYPTION_KEY
  keys:rotate                            Re-wrap account data keys with the current ENCRYPTION_KEY
                                         (run after moving the old key to ENCRYPTION_KEYS_PREVIOUS)
  db:migrate                             Apply database migrations
  users:create --email E --password P    Create a user with a personal workspace
  users:password --email E --password P  Set a user's password
  users:2fa:reset --email E              Remove a user's second factors (lost authenticator):
                                         authenticator app, passkeys, recovery codes
  connectors:list                        List available services
  accounts:list [--email E]              List connected accounts
  accounts:add --connector C --label L [--name N] [--description D]
               [--config JSON] [--credentials JSON] [--email E]
  accounts:remove --id ID [--email E]
  tokens:create --name NAME [--days N] [--email E]
                                         Create a personal access token (shown once)
  tools:list [--email E]                 Show the MCP tools the AI sees
  exposure:set --mode grouped|per_account [--email E]
  listing:set --mode auto|direct|discovery [--email E]

--email selects the user (defaults to ADMIN_EMAIL).`;

function parseJson(value: string | undefined, what: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`--${what} must be valid JSON`);
  }
}

async function workspaceFor(services: Services, email: string | undefined) {
  const address = email ?? services.config.admin?.email;
  if (!address) throw new Error('Pass --email or set ADMIN_EMAIL');
  const user = await findUserByEmail(services.db, address);
  if (!user) throw new Error(`No user with email ${address}`);
  const workspace = await getDefaultWorkspace(services.db, user.id);
  if (!workspace) throw new Error(`User ${address} has no workspace`);
  return { user, workspace };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    console.log(HELP);
    return;
  }
  if (command === 'keys:generate') {
    console.log(generateKey());
    return;
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      email: { type: 'string' },
      password: { type: 'string' },
      connector: { type: 'string' },
      name: { type: 'string' },
      label: { type: 'string' },
      description: { type: 'string' },
      config: { type: 'string' },
      credentials: { type: 'string' },
      id: { type: 'string' },
      days: { type: 'string' },
      mode: { type: 'string' },
    },
  });

  const config = loadConfig();
  const services = createServices(config, { logger: createLogger({ level: 'warn' }) });
  try {
    switch (command) {
      case 'db:migrate':
        await runMigrations(services.database.pool);
        console.log('Migrations applied.');
        break;
      case 'keys:rotate': {
        const result = await services.accounts.upgradeEncryption();
        console.log(
          `Accounts upgraded to their own data key: ${result.upgraded}; data keys re-wrapped: ${result.rewrapped}; unreadable: ${result.failed}.`,
        );
        if (result.failed) process.exitCode = 1;
        break;
      }
      case 'users:create': {
        if (!values.email || !values.password) throw new Error('--email and --password are required');
        const { user, workspace } = await createUser(services.db, {
          email: values.email,
          password: values.password,
        });
        console.log(`Created ${user.email} (${user.id}), workspace ${workspace.id}`);
        break;
      }
      case 'users:password': {
        if (!values.email || !values.password) throw new Error('--email and --password are required');
        const user = await findUserByEmail(services.db, values.email);
        if (!user) throw new Error('User not found');
        await setPassword(services.db, user.id, values.password);
        console.log('Password updated.');
        break;
      }
      case 'users:2fa:reset': {
        if (!values.email) throw new Error('--email is required');
        const user = await findUserByEmail(services.db, values.email);
        if (!user) throw new Error('User not found');
        const removed = await services.secondFactors.reset(user.id);
        await services.pendingLogins.deleteForUser(user.id);
        console.log(
          `Second factors removed for ${user.email}: authenticator app ${removed.totp ? 'yes' : 'no'}, ` +
            `passkeys ${removed.passkeys}, unused recovery codes ${removed.recoveryCodes}. ` +
            'The user can now sign in with the password alone and set up new factors on /security.',
        );
        break;
      }
      case 'connectors:list':
        for (const c of services.connectors.builtin.all()) {
          console.log(`${c.id.padEnd(16)} ${c.name} — ${c.description}`);
          console.log(`${''.padEnd(16)} actions: ${c.actions.map((a) => a.name).join(', ')}`);
        }
        break;
      case 'accounts:list': {
        const { workspace } = await workspaceFor(services, values.email);
        const rows = await services.accounts.list(workspace.id);
        if (rows.length === 0) console.log('No accounts.');
        for (const row of rows.map(toAccountView)) {
          console.log(
            `${row.id}  ${row.connectorId}/${row.name}  "${row.label}"  ${row.enabled ? row.status : 'disabled'}${row.identity ? `  ${row.identity}` : ''}`,
          );
        }
        break;
      }
      case 'accounts:add': {
        if (!values.connector || !values.label) throw new Error('--connector and --label are required');
        const { workspace } = await workspaceFor(services, values.email);
        const row = await services.accounts.create(workspace.id, {
          connectorId: values.connector,
          label: values.label,
          ...(values.name ? { name: values.name } : {}),
          ...(values.description ? { description: values.description } : {}),
          ...(values.config ? { config: parseJson(values.config, 'config') } : {}),
          ...(values.credentials ? { credentials: parseJson(values.credentials, 'credentials') } : {}),
        });
        const test = await services.accounts.test(workspace.id, row.id, services.logger);
        console.log(
          `Added ${row.connectorId}/${row.name} (${row.id}). Test: ${test.ok ? 'ok' : `failed — ${test.message}`}`,
        );
        break;
      }
      case 'accounts:remove': {
        if (!values.id) throw new Error('--id is required');
        const { workspace } = await workspaceFor(services, values.email);
        await services.accounts.delete(workspace.id, values.id);
        console.log('Removed.');
        break;
      }
      case 'tokens:create': {
        if (!values.name) throw new Error('--name is required');
        const { user, workspace } = await workspaceFor(services, values.email);
        const { token } = await services.apiTokens.create({
          workspaceId: workspace.id,
          userId: user.id,
          name: values.name,
          ...(values.days ? { expiresInDays: Number(values.days) } : {}),
        });
        console.log(token);
        console.error('Store it now: it cannot be shown again.');
        break;
      }
      case 'tools:list': {
        const { user, workspace } = await workspaceFor(services, values.email);
        const catalog = await services.hub.getCatalog({
          kind: 'session',
          userId: user.id,
          workspaceId: workspace.id,
          scopes: ['mcp', 'api'],
        });
        const { stats } = catalog;
        console.log(
          `Exposure: ${catalog.mode}, listing: ${catalog.listing} (${catalog.listed.length} of ${stats.totalTools} tools listed, ~${stats.listedTokens} tokens; all tools ~${stats.directTokens}, budget ${stats.budget})\n`,
        );
        for (const tool of catalog.tools) console.log(`${tool.name}\n  ${tool.description}\n`);
        break;
      }
      case 'exposure:set': {
        if (values.mode !== 'grouped' && values.mode !== 'per_account')
          throw new Error('--mode grouped|per_account');
        const { workspace } = await workspaceFor(services, values.email);
        await services.db
          .update(workspaces)
          .set({ settings: { ...workspace.settings, toolExposure: values.mode } })
          .where(eq(workspaces.id, workspace.id));
        console.log(`Tool exposure set to ${values.mode}.`);
        break;
      }
      case 'listing:set': {
        const mode = values.mode;
        if (mode !== 'auto' && mode !== 'direct' && mode !== 'discovery')
          throw new Error('--mode auto|direct|discovery');
        const { workspace } = await workspaceFor(services, values.email);
        await services.db
          .update(workspaces)
          .set({ settings: { ...workspace.settings, toolListing: mode } })
          .where(eq(workspaces.id, workspace.id));
        console.log(`Tool listing set to ${mode}.`);
        break;
      }
      default:
        console.error(`Unknown command: ${command}\n`);
        console.log(HELP);
        process.exitCode = 1;
    }
  } finally {
    await services.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
