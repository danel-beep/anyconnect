import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineConnector } from '../src/connectors/sdk.js';
import type { Principal } from '../src/core/principal.js';
import { triggerEvents, triggers as triggerTable } from '../src/db/schema.js';
import { registryWithFakeChat } from './fake-messenger.js';
import { resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

/** A calendar read through the shared `calendar.list_events`, as Google Calendar or Outlook are. */
interface TestEvent {
  id: string;
  title: string;
  start: string;
  all_day?: boolean;
  location?: string;
}
const calendar: TestEvent[] = [];
let reads = 0;
const testcal = defineConnector({
  id: 'testcal',
  name: 'TestCal',
  description: 'Test calendar',
  version: '1.0.0',
  config: z.object({}),
  actions: (action) => [
    action({
      name: 'events',
      title: 'List events',
      description: 'Lists the events of the test calendar.',
      input: z.object({ from: z.string(), to: z.string(), limit: z.number().default(50) }),
      hints: { readOnly: true },
      capability: 'calendar.list_events',
      // Like a real calendar: everything that overlaps the range, not only what starts in it.
      run: ({ to }) => {
        reads++;
        return { items: calendar.filter((e) => e.start.slice(0, 10) <= to.slice(0, 10)) };
      },
    }),
  ],
});

/** Calendar triggers: "N minutes before an event starts, do something". */
describe('calendar triggers', () => {
  let hub: TestHub;
  let workspaceId: string;
  let session: Principal;

  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
  const scan = () => hub.services.triggers.engine.scanAll('calendar', { background: false });
  const fired = async (triggerId: string) =>
    (await hub.services.triggers.service.events(workspaceId, { triggerId })).map((e) => e.item?.id).sort();
  const create = (input: Parameters<TestHub['services']['triggers']['service']['create']>[1]) =>
    hub.services.triggers.service.create(session, input);

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({
      connectors: (deps) => registryWithFakeChat(deps).register(testcal),
      seed: false,
    });
    const workspace = (await hub.services.db.query.workspaces.findFirst())!;
    const user = (await hub.services.db.query.users.findFirst())!;
    workspaceId = workspace.id;
    session = { kind: 'session', userId: user.id, workspaceId, scopes: [] };
    await hub.services.accounts.create(workspaceId, {
      connectorId: 'testcal',
      name: 'main',
      label: 'Main',
      credentials: {},
    });
  });

  afterAll(async () => {
    await hub?.close();
  });

  beforeEach(async () => {
    await hub.services.db.delete(triggerEvents);
    await hub.services.db.delete(triggerTable);
    calendar.length = 0;
    reads = 0;
  });

  it('fires once for an event that starts within the minutes the trigger asks for', async () => {
    const trigger = await create({ name: 'Meetings', when: 'calendar', do: 'check' });
    expect(trigger).toMatchObject({ when: 'calendar', accounts: 'all calendars' });
    calendar.push(
      { id: 'soon', title: 'Standup', start: inMinutes(5), location: 'Room 4' },
      { id: 'later', title: 'Review', start: inMinutes(45) },
      { id: 'running', title: 'Workshop', start: inMinutes(-30) },
      { id: 'day', title: 'Birthday', start: new Date().toISOString().slice(0, 10), all_day: true },
    );
    await scan();
    // Ten minutes by default: only the event that starts within them.
    expect(await fired(trigger.id)).toEqual(['soon']);
    const [event] = await hub.services.triggers.service.events(workspaceId, { triggerId: trigger.id });
    expect(event?.item).toMatchObject({ source: 'calendar', service: 'testcal', subject: 'Standup' });
    expect(event?.item?.text).toContain('Room 4');

    // The same event is not taken twice, and one made later inside the window is still found.
    calendar.push({ id: 'added', title: 'Call', start: inMinutes(3) });
    await scan();
    await scan();
    expect(await fired(trigger.id)).toEqual(['added', 'soon']);
  });

  it('reads a calendar once for triggers with different lead times and filters', async () => {
    const short = await create({ name: 'Soon', when: 'calendar', do: 'check' });
    const long = await create({
      name: 'Client calls',
      when: 'calendar',
      account: 'testcal:main',
      do: 'check',
      filter: { subject: 'client', minutes_before: 60 },
    });
    expect(long.filter).toEqual({ subject: 'client', minutes_before: 60 });
    calendar.push(
      { id: 'c1', title: 'Client call', start: inMinutes(40) },
      { id: 'c2', title: 'Client demo', start: inMinutes(8) },
      { id: 't1', title: 'Team lunch', start: inMinutes(30) },
    );
    await scan();
    expect(reads).toBe(1);
    expect(await fired(short.id)).toEqual(['c2']);
    expect(await fired(long.id)).toEqual(['c1', 'c2']);
  });

  it('tries a trigger on the next event of the calendar', async () => {
    const trigger = await create({
      name: 'Reviews',
      when: 'calendar',
      do: 'check',
      filter: { text: 'review' },
    });
    const signal = AbortSignal.timeout(10_000);
    const none = await hub.services.triggers.service.test(session, trigger.id, {
      run: false,
      force: false,
      signal,
    });
    expect(none).toMatchObject({ looked: 0, matched: false });
    expect(none.note).toContain('next day');
    calendar.push(
      { id: 'r2', title: 'Design review', start: inMinutes(600) },
      { id: 'r1', title: 'Code review', start: inMinutes(120) },
      { id: 'x', title: 'Lunch', start: inMinutes(60) },
    );
    const tried = await hub.services.triggers.service.test(session, trigger.id, {
      run: false,
      force: false,
      signal,
    });
    expect(tried).toMatchObject({ looked: 3, matched: true, item: { id: 'r1', title: 'Code review' } });
  });

  it('creates a calendar trigger from the form', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await browser.login();
    const html = await (await browser.request('/app/triggers')).text();
    expect(html).toContain('value="calendar:"');
    expect(html).toContain('value="calendar:testcal:main"');
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const form = { csrf, name: 'Before meetings', account: 'calendar:', do: 'check', dailyLimit: '50' };
    const posted = await browser.request('/app/triggers', { form: { ...form, minutesBefore: '30' } });
    expect(posted.status).toBe(303);
    const [created] = await hub.services.triggers.service.list(workspaceId);
    expect(created).toMatchObject({
      name: 'Before meetings',
      when: 'calendar',
      filter: { minutes_before: 30 },
    });
    const after = await (await browser.request('/app/triggers')).text();
    // The row names the setting (in the page's language) with its value.
    expect(after).toMatch(/: 30<\/div>/);
    // More than a day ahead is not offered.
    await browser.request('/app/triggers', { form: { ...form, name: 'Too early', minutesBefore: '5000' } });
    expect((await hub.services.triggers.service.list(workspaceId)).map((t) => t.name)).toEqual([
      'Before meetings',
    ]);
  });
});
