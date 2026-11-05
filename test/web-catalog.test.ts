import { describe, expect, it } from 'vitest';
import { arrangeCatalog, POPULAR_SERVICES, SAMPLE_SERVICES } from '../src/web/catalog.js';

const entry = (service: string, name: string, ready = true, custom = false) => ({
  service,
  name,
  ready,
  custom,
});

describe('dashboard catalog layout', () => {
  const entries = [
    entry('trello', 'Trello'),
    entry('gmail', 'Gmail', false),
    entry('slack', 'Slack'),
    entry('notion', 'Notion'),
    entry('outlook', 'Outlook'),
    entry('airtable', 'Airtable'),
    entry('crm', 'My CRM', true, true),
    entry('imap', 'Email (IMAP/SMTP)'),
  ];

  it('shows connectable popular services first, in popularity order, topped up by name', () => {
    const { popular } = arrangeCatalog(entries, 5);
    // Gmail is popular but cannot be connected here, so it is left out of the short row.
    expect(popular.map((e) => e.service)).toEqual(['outlook', 'slack', 'notion', 'imap', 'airtable']);
    expect(POPULAR_SERVICES.indexOf('outlook')).toBeLessThan(POPULAR_SERVICES.indexOf('slack'));
  });

  it('groups every connectable service by category and keeps the rest apart', () => {
    const { groups, unavailable } = arrangeCatalog(entries);
    expect(groups.map(([category, list]) => [category, list.map((e) => e.service)])).toEqual([
      ['mail', ['imap', 'outlook']],
      ['messengers', ['slack']],
      ['docs', ['airtable', 'notion']],
      ['tasks', ['trello']],
      ['custom', ['crm']],
    ]);
    expect(unavailable.map((e) => e.service)).toEqual(['gmail']);
  });

  it('treats the Demo service as sample data', () => {
    expect(SAMPLE_SERVICES.has('demo')).toBe(true);
    expect(SAMPLE_SERVICES.has('gmail')).toBe(false);
  });
});
