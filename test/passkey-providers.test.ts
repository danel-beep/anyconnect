import { describe, expect, it } from 'vitest';
import { describeAuthenticator, uniqueName } from '../src/core/passkey-providers.js';

describe('default passkey names', () => {
  it('names the password manager or platform from the AAGUID', () => {
    expect(describeAuthenticator('fbfc3007-154e-4ecc-8c0b-6e020557d7bd', ['internal', 'hybrid'])).toEqual({
      provider: 'iCloud Keychain',
      securityKey: false,
    });
    expect(describeAuthenticator('EA9B8D66-4D01-1D21-3CE4-B6B48CB575D4', []).provider).toBe(
      'Google Password Manager',
    );
  });

  it('recognises a hardware key by its transports when the AAGUID is unknown', () => {
    expect(describeAuthenticator('00000000-0000-0000-0000-000000000000', ['usb', 'nfc'])).toEqual({
      provider: null,
      securityKey: true,
    });
    expect(describeAuthenticator(undefined, ['internal']).securityKey).toBe(false);
    expect(describeAuthenticator(undefined, []).securityKey).toBe(false);
  });

  it('numbers a name the user already has', () => {
    expect(uniqueName('iCloud Keychain', [], 64)).toBe('iCloud Keychain');
    expect(uniqueName('iCloud Keychain', ['icloud keychain'], 64)).toBe('iCloud Keychain 2');
    expect(uniqueName('Passkey', ['Passkey', 'Passkey 2'], 64)).toBe('Passkey 3');
    expect(uniqueName('x'.repeat(64), ['x'.repeat(64)], 64)).toBe(`${'x'.repeat(62)} 2`);
  });
});
