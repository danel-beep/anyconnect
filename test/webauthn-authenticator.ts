import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';

/**
 * A software WebAuthn authenticator for tests: P-256 keys from node:crypto, attestation format
 * "none", authenticator data and CBOR built by hand, as a browser + platform authenticator would.
 */

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | { [key: string]: Cbor };

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

/** Minimal CBOR encoder (RFC 8949): integers, byte and text strings, arrays and maps. */
export function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  const entries: [Cbor, Cbor][] = value instanceof Map ? [...value] : Object.entries(value);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();
const b64url = (data: Uint8Array) => Buffer.from(data).toString('base64url');

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

interface StoredKey {
  id: Buffer;
  privateKey: KeyObject;
  userHandle: string;
  counter: number;
}

export class SoftwareAuthenticator {
  readonly keys: StoredKey[] = [];

  constructor(
    private readonly origin: string,
    private readonly rpId = new URL(origin).hostname,
  ) {}

  private authData(flags: number, counter: number, attested?: Buffer): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    return Buffer.concat([sha256(this.rpId), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  /** navigator.credentials.create() + PublicKeyCredential.toJSON(). */
  create(options: { challenge: string; user: { id: string } }) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const id = randomBytes(16);
    const coseKey = cbor(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(id.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, id, coseKey]);
    const authData = this.authData(FLAG_UP | FLAG_UV | FLAG_AT, 0, attested);
    this.keys.push({ id, privateKey, userHandle: options.user.id, counter: 0 });
    return {
      id: b64url(id),
      rawId: b64url(id),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge)),
        attestationObject: b64url(cbor({ fmt: 'none', attStmt: {}, authData })),
        transports: ['internal'],
      },
    };
  }

  /** navigator.credentials.get(): uses an allowed key, or any stored key (discoverable credential). */
  get(options: { challenge: string; allowCredentials?: { id: string }[] }) {
    const allowed = options.allowCredentials?.map((c) => c.id);
    const key = this.keys.find((k) => !allowed?.length || allowed.includes(b64url(k.id)));
    if (!key) throw new Error('No matching credential');
    key.counter += 1;
    const authData = this.authData(FLAG_UP | FLAG_UV, key.counter);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), key.privateKey);
    return {
      id: b64url(key.id),
      rawId: b64url(key.id),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: key.userHandle,
      },
    };
  }
}
