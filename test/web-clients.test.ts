import { describe, expect, it } from 'vitest';
import { guideForApp } from '../src/web/clients.js';

describe('guideForApp', () => {
  it('finds the logo of a known AI app by the name it signed in with', () => {
    expect(guideForApp('Claude')?.id).toBe('claude');
    expect(guideForApp('claude-code')?.id).toBe('claude-code');
    expect(guideForApp(null, 'Cursor (work)')?.id).toBe('cursor');
    expect(guideForApp('Visual Studio Code', 'VS Code')?.id).toBe('vscode');
    expect(guideForApp('ChatGPT')?.id).toBe('chatgpt');
  });

  it('leaves unknown apps without a guide', () => {
    expect(guideForApp('My script', undefined)).toBeUndefined();
  });
});
