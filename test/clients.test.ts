import { describe, expect, it } from 'vitest';
import { CLIENT_GUIDES, setupPrompt } from '../src/web/clients.js';

const URL_MAIN = 'https://manyplug.com/mcp';
const URL_PROFILE = 'https://manyplug.com/mcp/work';

describe('AI client setup', () => {
  it('gives every client one fastest way: a one-click install, a setup prompt or its settings page', () => {
    for (const g of CLIENT_GUIDES.filter((c) => c.id !== 'other')) {
      expect(Boolean(g.install || g.agent || g.open), g.id).toBe(true);
      // A prompt is built from the config it asks the agent to add.
      if (g.agent) expect(g.code, g.id).toBeDefined();
    }
  });

  it('builds a setup prompt with the exact config and the sign-in step, in both languages', () => {
    const cursor = CLIENT_GUIDES.find((c) => c.id === 'cursor')!;
    for (const lang of ['en', 'ru']) {
      const prompt = setupPrompt(cursor, URL_MAIN, lang)!;
      expect(prompt).toContain(cursor.code!(URL_MAIN));
      expect(prompt).toContain('~/.cursor/mcp.json');
      expect(prompt).not.toContain('{name}');
    }
    // An access profile's address keeps its own server name, so it never replaces the main one.
    const code = CLIENT_GUIDES.find((c) => c.id === 'claude-code')!;
    expect(setupPrompt(code, URL_PROFILE, 'en')).toContain('pick manyplug-work');
  });

  it('has no prompt for chat apps, which cannot add a connector themselves', () => {
    const claude = CLIENT_GUIDES.find((c) => c.id === 'claude')!;
    expect(setupPrompt(claude, URL_MAIN, 'en')).toBeUndefined();
    expect(claude.open?.href).toMatch(/^https:\/\//);
  });
});
