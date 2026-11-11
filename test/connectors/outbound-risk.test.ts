import { describe, expect, it } from 'vitest';
import cloudflare from '../../src/connectors/builtin/cloudflare.js';
import freshdesk from '../../src/connectors/builtin/freshdesk.js';
import gcal from '../../src/connectors/builtin/google-calendar.js';
import outlook from '../../src/connectors/builtin/outlook.js';
import { createBuiltinRegistry } from '../../src/connectors/index.js';
import { guestsRisk, invitationTextRisk } from '../../src/connectors/risk.js';
import { type ActionDefinition, actionRisk, type ConnectorDefinition } from '../../src/connectors/sdk.js';

/**
 * Calls that hand content to other people must not run silently under the default rules
 * ("confirm dangerous"): they are the way out for data an injected instruction made the AI read.
 */
const ctx = {} as never;
const action = (connector: ConnectorDefinition, name: string): ActionDefinition =>
  connector.actions.find((a) => a.name === name)!;

describe('risk of calls that reach other people', () => {
  it('asks before an event with guests, and not for the user’s own event', async () => {
    expect(guestsRisk({ attendees: [{ email: 'eve@example.test' }] })).toMatchObject({ risk: 'dangerous' });
    expect(guestsRisk({ attendees: [] })).toBeUndefined();
    expect(guestsRisk({ summary: 'Gym' })).toBeUndefined();
    expect(invitationTextRisk('Lunch with eve@example.test tomorrow 1pm')).toMatchObject({
      risk: 'dangerous',
    });
    expect(invitationTextRisk('Lunch with Ann tomorrow 1pm')).toBeUndefined();
  });

  it('applies to Google Calendar and Outlook events', async () => {
    const guests = { attendees: [{ email: 'eve@example.test' }] };
    for (const name of ['create_event', 'update_event']) {
      expect(await action(gcal, name).assessRisk!({ summary: 'Sync', ...guests }, ctx)).toMatchObject({
        risk: 'dangerous',
      });
      expect(await action(gcal, name).assessRisk!({ summary: 'Gym' }, ctx)).toBeUndefined();
      expect(
        await action(outlook, name).assessRisk!({ subject: 'Sync', attendees: ['eve@example.test'] }, ctx),
      ).toMatchObject({ risk: 'dangerous' });
      expect(await action(outlook, name).assessRisk!({ subject: 'Gym' }, ctx)).toBeUndefined();
    }
    expect(
      await action(gcal, 'quick_add').assessRisk!({ text: 'Call eve@example.test at 5' }, ctx),
    ).toMatchObject({
      risk: 'dangerous',
    });
    expect(await action(gcal, 'quick_add').assessRisk!({ text: 'Gym at 5' }, ctx)).toBeUndefined();
  });

  it('asks before any DNS change, a new record included', () => {
    for (const name of ['create_dns_record', 'update_dns_record', 'delete_dns_record']) {
      expect(action(cloudflare, name).risk).toBe('dangerous');
    }
  });

  it('asks before a public Freshdesk note, not before a private one', async () => {
    const note = action(freshdesk, 'add_note');
    expect(await note.assessRisk!({ ticket_id: 1, body: 'x', private: false }, ctx)).toMatchObject({
      risk: 'dangerous',
    });
    expect(await note.assessRisk!({ ticket_id: 1, body: 'x' }, ctx)).toBeUndefined();
  });

  it('marks what can land in a public place, so the exposure stage can ask after an outside read', () => {
    const tagged = createBuiltinRegistry()
      .all()
      .flatMap((c) => c.actions.filter((a) => a.tags?.includes('publishes')).map((a) => `${c.id}.${a.name}`))
      .sort();
    expect(tagged).toEqual([
      'bitbucket.add_comment',
      'bitbucket.add_inline_comment',
      'github.add_comment',
      'github.create_issue',
      'github.update_issue',
      'gitlab.add_note',
      'gitlab.create_issue',
      'gitlab.update_issue',
      'http.request',
      'wordpress.update_post',
    ]);
  });

  it('never lets an action named like sending run silently', () => {
    const silent: string[] = [];
    for (const connector of createBuiltinRegistry().all()) {
      for (const a of connector.actions) {
        if (!/^(send|post|publish|share|invite|reply|forward)(_|$)/.test(a.name)) continue;
        if (actionRisk(a) !== 'dangerous' && !a.assessRisk) silent.push(`${connector.id}.${a.name}`);
      }
    }
    expect(silent).toEqual([]);
  });

  it('holds for every built-in action that takes attendees', () => {
    const silent: string[] = [];
    for (const connector of createBuiltinRegistry().all()) {
      for (const a of connector.actions) {
        if (a.risk === 'dangerous' || a.hints?.readOnly || a.assessRisk) continue;
        const shape = (a.input as { shape?: Record<string, unknown> }).shape ?? {};
        const declared = { ...shape, ...(a.inputSchema?.properties as Record<string, unknown> | undefined) };
        if ('attendees' in declared) silent.push(`${connector.id}.${a.name}`);
      }
    }
    expect(silent).toEqual([]);
  });
});
