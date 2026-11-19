import { deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { NodeCryptoProvider } from '../src/gateway/drivers/telegram/platform.js';

// The gateway's own mtcute crypto provider (instead of @mtcute/node): each mtcute update can add
// a method to ICryptoProvider, and these checks keep the compression ones honest.
describe('NodeCryptoProvider compression', () => {
  const crypto = new NodeCryptoProvider();
  const text = new TextEncoder().encode('<html>widget</html>'.repeat(50));

  it('gzip output round-trips and respects the size cap', () => {
    const packed = crypto.gzip(text, 10_000);
    expect(packed).not.toBeNull();
    expect(crypto.gzip(text, 4)).toBeNull();
    expect(Buffer.from(crypto.gunzip(gzipSync(text)))).toEqual(Buffer.from(text));
  });

  it('inflate unpacks zlib data and refuses output over maxSize', () => {
    const packed = deflateSync(text);
    expect(Buffer.from(crypto.inflate(packed, text.length))).toEqual(Buffer.from(text));
    expect(() => crypto.inflate(packed, text.length - 1)).toThrow();
  });
});
