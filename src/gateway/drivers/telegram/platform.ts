/**
 * The Node.js pieces mtcute needs (crypto, TCP, platform hooks), written here instead of taken
 * from `@mtcute/node`: that package pulls in a native SQLite module the gateway does not use
 * (session state lives in Postgres, see `storage.ts`), and its exit hooks would fight the
 * gateway's own graceful shutdown.
 */
import { createCipheriv, createHash, createHmac, pbkdf2, randomFillSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { deflateSync, gunzipSync } from 'node:zlib';
import { connectTcp } from '@fuman/node';
import { type ICorePlatform, IntermediatePacketCodec, type TelegramTransport } from '@mtcute/core';
import {
  BaseCryptoProvider,
  type IAesCtr,
  type ICryptoProvider,
  type IEncryptionScheme,
} from '@mtcute/core/utils.js';
import { ige256Decrypt, ige256Encrypt, initSync, SIMD_AVAILABLE } from '@mtcute/wasm';
import type { ConnectorLogger, NetworkAccess } from '../../../connectors/sdk.js';

export class NodeCryptoProvider extends BaseCryptoProvider implements ICryptoProvider {
  createAesCtr(key: Uint8Array, iv: Uint8Array): IAesCtr {
    const cipher = createCipheriv(`aes-${key.length * 8}-ctr`, key, iv);
    return { process: (data: Uint8Array) => cipher.update(data) };
  }

  pbkdf2(password: Uint8Array, salt: Uint8Array, iterations: number, keylen = 64, algo = 'sha512') {
    return new Promise<Uint8Array>((resolve, reject) =>
      pbkdf2(password, salt, iterations, keylen, algo, (err, buf) => (err ? reject(err) : resolve(buf))),
    );
  }

  sha1(data: Uint8Array): Uint8Array {
    return createHash('sha1').update(data).digest();
  }

  sha256(data: Uint8Array): Uint8Array {
    return createHash('sha256').update(data).digest();
  }

  hmacSha256(data: Uint8Array, key: Uint8Array): Uint8Array {
    return createHmac('sha256', key).update(data).digest();
  }

  gzip(data: Uint8Array, maxSize: number): Uint8Array | null {
    try {
      return deflateSync(data, { maxOutputLength: maxSize });
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') return null;
      throw error;
    }
  }

  gunzip(data: Uint8Array): Uint8Array {
    return gunzipSync(data);
  }

  randomFill(buf: Uint8Array): void {
    randomFillSync(buf);
  }

  async initialize(): Promise<void> {
    await initWasm();
  }

  createAesIge(key: Uint8Array, iv: Uint8Array): IEncryptionScheme {
    return {
      encrypt: (data: Uint8Array) => ige256Encrypt(data, key, iv),
      decrypt: (data: Uint8Array) => ige256Decrypt(data, key, iv),
    };
  }
}

let wasmReady: Promise<void> | undefined;

/** Loads mtcute's AES-IGE module once per process (every client shares it). */
function initWasm(): Promise<void> {
  wasmReady ??= (async () => {
    const require = createRequire(import.meta.url);
    const file = require.resolve(`@mtcute/wasm/${SIMD_AVAILABLE ? 'mtcute-simd.wasm' : 'mtcute.wasm'}`);
    initSync(await readFile(file));
  })();
  return wasmReady;
}

/** TCP to Telegram's data centers, checked against the hub's network policy first. */
export class PolicyTcpTransport implements TelegramTransport {
  constructor(private readonly network: NetworkAccess) {}

  async connect(dc: { ipAddress: string; port: number }, abortSignal: AbortSignal) {
    this.network.assertHostAllowed(dc.ipAddress);
    const conn = await connectTcp({ address: dc.ipAddress, port: dc.port }, abortSignal);
    conn.setNoDelay(true);
    conn.setKeepAlive(true);
    return conn;
  }

  packetCodec() {
    return new IntermediatePacketCodec();
  }
}

/** Device name shown in the user's Telegram under Settings → Devices. */
export const DEVICE_MODEL = 'Manyplug';

/**
 * Platform hooks: mtcute's log lines go to the account's logger, and only their fixed format
 * string: the arguments can hold message content or phone numbers.
 */
export function gatewayPlatform(logger: ConnectorLogger): ICorePlatform {
  return {
    beforeExit: () => () => {},
    log: (_color, level, tag, fmt) => {
      // mtcute levels: 1 error, 2 warn, 3 info, 4 debug, 5 verbose.
      if (level === 1) logger.warn({ tag }, `mtcute: ${fmt}`);
      else if (level === 2) logger.debug({ tag }, `mtcute: ${fmt}`);
    },
    getDefaultLogLevel: () => 2,
    getDeviceModel: () => DEVICE_MODEL,
  };
}
