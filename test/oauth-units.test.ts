import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { isPublicAddress } from '../src/lib/safe-fetch.js';
import { slugify } from '../src/lib/slug.js';
import { isMetadataDocumentClientId } from '../src/oauth/clients.js';
import { isLoopbackRedirect, redirectUriMatches, validateRedirectUri } from '../src/oauth/redirect.js';

describe('redirect URIs', () => {
  it('validates registrations', () => {
    expect(validateRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBeUndefined();
    expect(validateRedirectUri('http://localhost:3118/callback')).toBeUndefined();
    expect(validateRedirectUri('http://127.0.0.1/callback')).toBeUndefined();
    expect(validateRedirectUri('cursor://anysphere.cursor-retrieval/oauth/callback')).toBeUndefined();
    expect(validateRedirectUri('http://evil.example/cb')).toMatch(/loopback/);
    expect(validateRedirectUri('https://a.example/cb#frag')).toMatch(/fragment/);
    expect(validateRedirectUri('javascript:alert(1)')).toBeDefined();
    expect(validateRedirectUri('not a url')).toBeDefined();
  });

  it('matches exactly, except the port of loopback redirects', () => {
    const registered = ['http://localhost/callback', 'https://claude.ai/api/mcp/auth_callback'];
    expect(redirectUriMatches(registered, 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(redirectUriMatches(registered, 'http://localhost:51234/callback')).toBe(true);
    expect(redirectUriMatches(registered, 'http://127.0.0.1:51234/callback')).toBe(false);
    expect(redirectUriMatches(registered, 'http://localhost:51234/other')).toBe(false);
    expect(redirectUriMatches(registered, 'https://claude.ai/api/mcp/auth_callback?x=1')).toBe(false);
    expect(isLoopbackRedirect('http://[::1]:8080/cb')).toBe(true);
  });

  it('recognizes Client ID Metadata Document ids', () => {
    expect(isMetadataDocumentClientId('https://claude.ai/oauth/claude-code-client-metadata')).toBe(true);
    expect(isMetadataDocumentClientId('https://claude.ai/')).toBe(false);
    expect(isMetadataDocumentClientId('http://claude.ai/meta')).toBe(false);
    expect(isMetadataDocumentClientId('cli_123')).toBe(false);
  });
});

describe('SSRF guard', () => {
  it('only allows public addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.1',
      '172.20.0.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '0.0.0.0',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])
      expect(isPublicAddress(ip), ip).toBe(true);
  });
});

describe('config', () => {
  const base = { DATABASE_URL: 'postgres://x', NODE_ENV: 'production', ENCRYPTION_KEY: 'k'.repeat(44) };

  it('requires https and an encryption key in production', () => {
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'http://hub.example.com' })).toThrow(/https/);
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: '', PUBLIC_URL: 'https://hub.example.com' })).toThrow(
      /ENCRYPTION_KEY/,
    );
    const config = loadConfig({ ...base, PUBLIC_URL: 'https://hub.example.com/' });
    expect(config.mcpUrl).toBe('https://hub.example.com/mcp');
    expect(config.secureCookies).toBe(true);
  });

  it('uses the Render URL and trusts the proxy on Render', () => {
    const config = loadConfig({
      ...base,
      RENDER: 'true',
      RENDER_EXTERNAL_URL: 'https://anyconnect.onrender.com',
    });
    expect(config.publicUrl).toBe('https://anyconnect.onrender.com');
    expect(config.trustProxy).toBe(true);
  });

  it('rejects a public URL with a path', () => {
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'https://hub.example.com/sub' })).toThrow(/origin/);
  });
});

describe('slugify', () => {
  it('transliterates labels into account names', () => {
    expect(slugify('Рабочая почта')).toBe('rabochaya_pochta');
    expect(slugify('Shop @ Telegram!')).toBe('shop_telegram');
  });
});
