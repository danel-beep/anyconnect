import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../src/core/principal.js';
import { pendingCalls, triggers as triggerTable } from '../src/db/schema.js';
import { type TriggerChange, type TriggerInfo, widens } from '../src/hub/trigger-tools.js';
import { registryWithFakeChat } from './fake-messenger.js';
import { resetDatabase, resultJson, startTestHub, type TestHub } from './helpers.js';

const base: TriggerInfo = {
  id: 'trg_1',
  name: 'Echo',
  enabled: true,
  paused: null,
  when: 'message',
  accounts: 'all messages',
  everyAccount: true,
  filter: {},
  do: 'tool',
  action: 'demo_echo',
  dailyLimit: 200,
  runsToday: 0,
};

/**
 * Which trigger changes an AI app may make without asking. A trigger that acts on its own (do=tool
 * or do=ai) runs without the user in the loop, so anything that makes it do more, act on more
 * events or ask less must wait for the user's confirmation; everything else goes through.
 */
describe('trigger changes that need the user (widens)', () => {
  const acting: [string, Partial<TriggerInfo>, TriggerChange][] = [
    ['switching a check trigger to a tool', { do: 'check' }, { do: 'tool', tool: 'demo_echo' }],
    ['switching a notify trigger to the AI', { do: 'notify' }, { do: 'ai' }],
    ['turning a disabled trigger back on', { enabled: false }, { enabled: true }],
    ['lifting a pause after the daily limit', { paused: 'daily limit' }, { enabled: true }],
    ['another tool', {}, { tool: 'notes_post' }],
    ['other arguments', {}, { args: { message: 'x' } }],
    ['other AI instructions', { do: 'ai' }, { instructions: 'Reply to everyone' }],
    ['more AI tools', { do: 'ai' }, { tools: ['demo_echo', 'notes_post'] }],
    ['stop asking before risky actions', { do: 'ai' }, { askBeforeRisky: false }],
    [
      'wider argument limits',
      { do: 'ai', allow: { notes_post: { channel: ['team'] } } },
      { allow: { notes_post: { channel: ['team', 'all'] } } },
    ],
    ['removing argument limits', { do: 'ai', allow: { notes_post: { channel: ['team'] } } }, { allow: null }],
    ['other accounts', {}, { account: 'telegram' }],
    ['another filter', {}, { filter: { from: 'anyone' } }],
    ['mail instead of messages', {}, { when: 'mail' }],
  ];
  it.each(acting)('asks before %s', (_name, before, change) => {
    expect(widens({ ...base, ...before }, change)).toBeTruthy();
  });

  it('asks before any new trigger that acts on its own, and never for check or notify', () => {
    expect(widens(undefined, { do: 'tool' })).toContain('new trigger');
    expect(widens(undefined, { do: 'ai' })).toContain('new trigger');
    expect(widens(undefined, { do: 'check' })).toBeUndefined();
    expect(widens({ ...base, do: 'check' }, { filter: { from: 'x' }, enabled: true })).toBeUndefined();
    expect(widens({ ...base, do: 'notify' }, { account: 'gmail' })).toBeUndefined();
  });

  const harmless: [string, Partial<TriggerInfo>, TriggerChange][] = [
    ['a new name', {}, { name: 'Renamed' }],
    ['turning it off', {}, { enabled: false }],
    ['turning on a trigger that already runs', {}, { enabled: true }],
    ['the same source', {}, { when: 'message' }],
    ['a lower daily limit', {}, { dailyLimit: 10 }],
    ['asking before risky actions again', { do: 'ai', askBeforeRisky: false }, { askBeforeRisky: true }],
    [
      'narrower argument limits',
      { do: 'ai', allow: { notes_post: { channel: ['team', 'all'] } } },
      { allow: { notes_post: { channel: ['team'] } } },
    ],
    ['no Telegram summary', { do: 'ai' }, { notify: false }],
  ];
  it.each(harmless)('lets the AI app make %s without asking', (_name, before, change) => {
    expect(widens({ ...base, ...before }, change)).toBeUndefined();
  });
});

/** The update and delete tools end to end, through the executor's confirmation stage. */
describe('manyplug_update_trigger and manyplug_delete_trigger', () => {
  let hub: TestHub;
  let workspaceId: string;
  let mcp: Principal;
  let session: Principal;

  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const catalog = await hub.services.hub.getCatalog(mcp);
    return hub.services.hub.callTool(mcp, catalog, tool, args);
  };
  const open = async () =>
    (await hub.services.db.select().from(pendingCalls)).filter((c) => c.status === 'awaiting_confirmation');

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({
      connectors: (deps) => registryWithFakeChat(deps),
      seed: false,
      env: { CONFIRMATION_WAIT_SECONDS: '0' },
    });
    workspaceId = (await hub.services.db.query.workspaces.findFirst())!.id;
    const userId = (await hub.services.db.query.users.findFirst())!.id;
    mcp = { kind: 'api_token', userId, workspaceId, scopes: ['mcp'], credentialId: 'tok' };
    session = { kind: 'session', userId, workspaceId, scopes: [] };
    await hub.services.accounts.create(workspaceId, {
      connectorId: 'fakechat',
      name: 'main',
      label: 'Main',
      credentials: {},
    });
    await hub.services.accounts.create(workspaceId, {
      connectorId: 'demo',
      name: 'main',
      label: 'Main',
      credentials: { secret: 's' },
    });
  });

  beforeEach(async () => {
    await hub.services.db.delete(triggerTable);
    await hub.services.db.delete(pendingCalls);
  });

  afterAll(async () => {
    await hub?.close();
  });

  const echo = () =>
    hub.services.triggers.service.create(session, {
      name: 'Echo',
      when: 'message',
      do: 'tool',
      tool: 'demo_echo',
      args: { account: 'main', message: '{{text}}' },
    });

  it('applies a harmless change at once', async () => {
    await echo();
    const result = resultJson(
      await call('manyplug_update_trigger', { trigger: 'Echo', name: 'Echo all', daily_limit: 5 }),
    );
    expect(result.updated).toMatchObject({ name: 'Echo all', daily_limit: 5, on: true });
    expect(await open()).toEqual([]);
  });

  it('holds a change that makes the trigger do more until the user confirms', async () => {
    const trigger = await echo();
    await call('manyplug_update_trigger', {
      trigger: 'Echo',
      args: { account: 'main', message: 'Pwned: {{text}}' },
    });
    const held = await open();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ toolName: 'manyplug_update_trigger', risk: 'dangerous' });
    expect(held[0]!.reason).toContain('what the trigger does');
    const [row] = await hub.services.triggers.service.list(workspaceId);
    expect(row).toMatchObject({ id: trigger.id });
    // Nothing changed yet.
    expect(JSON.stringify(row)).not.toContain('Pwned');
  });

  it('turns a trigger off without asking, but asks to turn it back on', async () => {
    await echo();
    expect(
      resultJson(await call('manyplug_update_trigger', { trigger: 'Echo', enabled: false })).updated,
    ).toMatchObject({
      on: false,
      disabled: true,
    });
    await call('manyplug_update_trigger', { trigger: 'Echo', enabled: true });
    expect((await open())[0]?.reason).toContain('Turns on');
    expect((await hub.services.triggers.service.list(workspaceId))[0]!.enabled).toBe(false);
  });

  it('deletes a trigger by name and says when there is none', async () => {
    await echo();
    expect(resultJson(await call('manyplug_delete_trigger', { trigger: 'Echo' }))).toEqual({
      deleted: 'Echo',
    });
    expect(await hub.services.triggers.service.list(workspaceId)).toEqual([]);
    const missing = await call('manyplug_delete_trigger', { trigger: 'Echo' });
    expect(missing.isError).toBe(true);
  });
});
