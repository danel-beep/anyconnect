import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from '../src/core/identity.js';
import type { Principal } from '../src/core/principal.js';
import { triggers } from '../src/db/schema.js';
import { registryWithFakeChat } from './fake-messenger.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

/**
 * Triggers in a team watch only the team's own accounts. A member's own account is private to
 * them (admins included, `memberAccess`), and a trigger hands what arrives to whoever made it
 * (notices, tests, an AI run) and to the team's trigger log. A member who leaves takes their
 * triggers with them.
 */
describe('triggers in a team', () => {
  let hub: TestHub;
  let teamId = '';
  let teamAccount = '';
  let bobAccount = '';
  let ann: Principal;
  let bob: Principal;
  let seq = 0;

  const inbound = async (accountId: string, text: string) => {
    seq++;
    await hub.services.messaging.store.ingest(accountId, [
      {
        chat: { externalId: 'chat-x', kind: 'direct', title: 'Xena' },
        externalId: `m${seq}`,
        direction: 'in',
        sentAt: new Date(),
        sender: { externalId: 'u-x', name: 'Xena' },
        text,
      },
    ]);
    await hub.services.triggers.engine.onInbound(accountId);
  };
  const eventTexts = async (triggerId: string) => {
    for (let i = 0; i < 50; i++) {
      const events = await hub.services.triggers.service.events(teamId, { triggerId });
      if (events.every((e) => e.status !== 'running')) return events.map((e) => e.item?.text);
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error('trigger events did not settle');
  };

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ connectors: (deps) => registryWithFakeChat(deps), seed: false });
    const db = hub.services.db;
    const a = await createUser(db, { email: 'ann@example.com', password: 'ann-correct-horse', name: 'Ann' });
    const b = await createUser(db, { email: 'bob@example.com', password: 'bob-correct-horse', name: 'Bob' });
    const team = await hub.services.teams.create(
      { id: a.user.id, name: 'Ann', email: 'ann@example.com' },
      'Studio',
    );
    teamId = team.id;
    const { url } = await hub.services.teams.invite(a.user.id, teamId, { email: 'bob@example.com' });
    await hub.services.teams.accept(new URL(url).pathname.split('/').at(-1)!, {
      id: b.user.id,
      email: 'bob@example.com',
      name: 'Bob',
    });
    ann = { kind: 'session', userId: a.user.id, workspaceId: teamId, scopes: [] };
    bob = { kind: 'session', userId: b.user.id, workspaceId: teamId, scopes: [] };
    teamAccount = (
      await hub.services.accounts.create(
        teamId,
        { connectorId: 'fakechat', name: 'desk', label: 'Desk', credentials: {} },
        { userId: null },
      )
    ).id;
    bobAccount = (
      await hub.services.accounts.create(
        teamId,
        { connectorId: 'fakechat', name: 'bob', label: 'Bob private', credentials: {} },
        { userId: b.user.id },
      )
    ).id;
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('offers only the team’s own accounts to watch', async () => {
    const watchable = await hub.services.triggers.engine.sourceAccounts('message', teamId);
    expect(watchable.map((row) => row.id)).toEqual([teamAccount]);
    await expect(
      hub.services.triggers.service.create(ann, {
        name: 'Bob mail',
        when: 'message',
        do: 'check',
        account: 'fakechat:bob',
      }),
    ).rejects.toThrow(/No .*"fakechat:bob"/);
  });

  it('an admin’s trigger on every account never sees a member’s own messages', async () => {
    const trigger = await hub.services.triggers.service.create(ann, {
      name: 'Everything',
      when: 'message',
      do: 'check',
    });
    await inbound(bobAccount, 'private to Bob');
    await inbound(teamAccount, 'for the whole team');
    // The backstop pass over every account reads the same way.
    await hub.services.triggers.engine.scanAll('message', { background: true });
    expect(await eventTexts(trigger.id)).toEqual(['for the whole team']);
    // A test of the trigger looks at the same accounts.
    const tried = await hub.services.triggers.service.test(ann, 'Everything', {
      run: false,
      force: false,
      signal: AbortSignal.timeout(5_000),
    });
    expect(tried.item).toMatchObject({ account: 'desk', preview: 'for the whole team' });
  });

  it('a member who leaves takes their triggers with them', async () => {
    const own = await hub.services.triggers.service.create(bob, {
      name: 'Bob watches the desk',
      when: 'message',
      do: 'check',
    });
    await hub.services.teams.leave(bob.userId, teamId);
    const left = await hub.services.db.select().from(triggers).where(eq(triggers.workspaceId, teamId));
    expect(left.map((t) => t.id)).not.toContain(own.id);
    expect(left).toHaveLength(1);
  });
});
