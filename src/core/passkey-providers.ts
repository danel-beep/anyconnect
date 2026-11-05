/**
 * Who keeps a new passkey, from the authenticator's AAGUID (sent in every registration, even with
 * `attestation: 'none'`). Used only to give the passkey a useful default name ("iCloud Keychain"
 * instead of "Passkey"), so the user never has to type one. Unknown AAGUIDs are fine: the name then
 * falls back to the kind of authenticator.
 *
 * Source: the community list at github.com/passkeydeveloper/passkey-authenticator-aaguids. A wrong or
 * missing entry only changes a default name, which the user can rename.
 */
const PROVIDERS: Record<string, string> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  '771b48fd-d3d4-4f74-9232-fc157ab0507a': 'Edge on Mac',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  'b84e4048-15dc-4dd0-8640-f4f60813c8af': 'NordPass',
  '0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6': 'Keeper',
  'f3809540-7f14-49c1-a8b3-8f813b225541': 'Enpass',
  'fdb141b2-5d84-443e-8a35-4698c205a502': 'KeePassXC',
};

/** What the hub knows about the authenticator that created a passkey. */
export interface AuthenticatorInfo {
  /** Password manager or platform that keeps the passkey, when the AAGUID is known. */
  provider: string | null;
  /** A hardware key plugged in or tapped (USB, NFC, Bluetooth) rather than this device or an app. */
  securityKey: boolean;
}

const HARDWARE_TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'smart-card']);

export function describeAuthenticator(
  aaguid: string | undefined,
  transports: readonly string[],
): AuthenticatorInfo {
  const provider = aaguid ? (PROVIDERS[aaguid.toLowerCase()] ?? null) : null;
  const securityKey =
    provider === null &&
    transports.length > 0 &&
    !transports.includes('internal') &&
    !transports.includes('hybrid') &&
    transports.some((t) => HARDWARE_TRANSPORTS.has(t));
  return { provider, securityKey };
}

/** `base`, or `base 2`, `base 3`… when the user already has a passkey with that name. */
export function uniqueName(base: string, taken: readonly string[], max: number): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  const clean = base.trim().slice(0, max);
  if (!used.has(clean.toLowerCase())) return clean;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = `${clean.slice(0, max - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
