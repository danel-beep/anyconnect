import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contentType,
  describeFileArguments,
  resolveFileInput,
  sniffMime,
} from '../src/connectors/file-input.js';
import { DeliveryError, type FileRules } from '../src/connectors/messaging.js';
import { downloadForUpload } from '../src/connectors/messaging-http.js';
import { cleanName, FileStore } from '../src/core/files.js';
import { hubFiles, workspaces } from '../src/db/schema.js';
import { builtinJobs } from '../src/jobs/builtin.js';
import { newId } from '../src/lib/ids.js';
import { createNetworkPolicy } from '../src/lib/network.js';
import { fitFile } from '../src/messaging/file-rules.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('files the hub keeps for tools (ctx.files)', () => {
  let hub: TestHub;
  let mine: string;
  let theirs: string;
  let now = new Date('2026-11-19T10:00:00Z');
  let store: FileStore;

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub();
    mine = (await hub.services.db.query.workspaces.findFirst())!.id;
    theirs = newId('wsp');
    await hub.services.db.insert(workspaces).values({ id: theirs, name: 'Other' });
    store = new FileStore(
      hub.services.db,
      hub.services.secrets,
      { maxBytes: 16, maxWorkspaceBytes: 40, ttlMs: 3_600_000 },
      () => now,
    );
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('keeps a file encrypted and returns it to its workspace only', async () => {
    const files = store.forWorkspace(mine);
    const kept = await files.put({
      data: bytes(1, 2, 3, 4),
      name: '../../etc/Report Q3.pdf',
      mimeType: 'Application/PDF; x=1',
    });
    expect(kept).toMatchObject({ name: 'Report Q3.pdf', mimeType: 'application/pdf', size: 4 });
    expect(kept.id).toMatch(/^file_/);
    expect((await files.get(kept.id)).data).toEqual(bytes(1, 2, 3, 4));
    expect(await files.stat(kept.id)).toMatchObject({ name: 'Report Q3.pdf', size: 4 });

    // At rest: neither the name nor the bytes are readable.
    const [row] = await hub.services.db.select().from(hubFiles).where(eq(hubFiles.id, kept.id));
    expect(row!.nameEncrypted).not.toContain('Report');
    expect(Buffer.from(row!.data).includes(Buffer.from([1, 2, 3, 4]))).toBe(false);

    // Another workspace does not see it, however it asks.
    await expect(store.forWorkspace(theirs).get(kept.id)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(files.get('file_../../x')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('gives the same id to the same bytes and a fresh expiry', async () => {
    const files = store.forWorkspace(mine);
    const first = await files.put({ data: bytes(9, 9), name: 'a.png', mimeType: 'image/png' });
    now = new Date(now.getTime() + 30 * 60_000);
    const second = await files.put({ data: bytes(9, 9), name: 'b.png', mimeType: 'image/png' });
    expect(second.id).toBe(first.id);
    expect(second.expiresAt.getTime()).toBeGreaterThan(first.expiresAt.getTime());
    // Other bytes, or the same bytes in another workspace, are other files.
    expect((await files.put({ data: bytes(9, 8), name: 'c.png', mimeType: 'image/png' })).id).not.toBe(
      first.id,
    );
    expect(
      (await store.forWorkspace(theirs).put({ data: bytes(9, 9), name: 'a.png', mimeType: 'image/png' })).id,
    ).not.toBe(first.id);
  });

  it('refuses empty and oversized files and a full workspace', async () => {
    const files = store.forWorkspace(theirs);
    await expect(files.put({ data: bytes(), name: 'x', mimeType: 'text/plain' })).rejects.toThrow(/empty/);
    await expect(files.put({ data: new Uint8Array(17), name: 'x', mimeType: 'text/plain' })).rejects.toThrow(
      /up to/,
    );
    await files.put({ data: new Uint8Array(16).fill(1), name: 'x', mimeType: 'text/plain' });
    await files.put({ data: new Uint8Array(16).fill(2), name: 'y', mimeType: 'text/plain' });
    await expect(
      files.put({ data: new Uint8Array(16).fill(3), name: 'z', mimeType: 'text/plain' }),
    ).rejects.toThrow(/already keeps/);
  });

  it('forgets files once they expire, and the clean-up job deletes them', async () => {
    const files = store.forWorkspace(mine);
    const kept = await files.put({ data: bytes(5, 5, 5), name: 'later.txt', mimeType: 'text/plain' });
    expect(await store.getForAccount('acc_nobody', kept.id)).toBeUndefined();
    now = new Date(now.getTime() + 2 * 3_600_000);
    await expect(files.get(kept.id)).rejects.toThrow(/about a day/);
    const job = builtinJobs({ files: store } as never).find((j) => j.name === 'files.prune')!;
    await job.run({}, {} as never);
    expect(await hub.services.db.select().from(hubFiles).where(eq(hubFiles.id, kept.id))).toHaveLength(0);
  });

  it('turns tool inputs into one file', async () => {
    const files = store.forWorkspace(mine);
    expect(await resolveFileInput({}, { files })).toBeUndefined();
    expect(await resolveFileInput({ file_url: 'https://x.example/a/photo.JPG' }, { files })).toEqual({
      source: 'url',
      url: 'https://x.example/a/photo.JPG',
      name: 'photo.JPG',
      mimeType: 'image/jpeg',
    });
    const fromBase64 = await resolveFileInput(
      { file_base64: Buffer.from([0x25, 0x50, 0x44, 0x46, 1]).toString('base64') },
      { files },
    );
    expect(fromBase64).toMatchObject({ source: 'kept', name: 'file', mimeType: 'application/pdf', size: 5 });
    await expect(resolveFileInput({ file_id: 'file_x' }, {})).rejects.toThrow(/cannot keep files/);
    await expect(resolveFileInput({ file_base64: 'not base64!' }, { files })).rejects.toThrow(
      /not valid base64/,
    );
  });

  it('recognizes common formats and cleans file names', () => {
    expect(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffMime(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8'))).toBe('image/webp');
    expect(sniffMime(new TextEncoder().encode('\0\0\0\x18ftypisom'))).toBe('video/mp4');
    expect(sniffMime(new TextEncoder().encode('OggS'))).toBe('audio/ogg');
    expect(sniffMime(bytes(1, 2, 3))).toBeUndefined();
    expect(cleanName('C:\\Users\\me\\photo\u0007.jpg')).toBe('photo.jpg');
    expect(cleanName('   ')).toBe('file');
  });

  it('trusts the bytes over a claimed photo type', () => {
    expect(contentType(bytes(0x89, 0x50, 0x4e, 0x47), 'image/jpeg')).toBe('image/png');
    // An error page served as a JPEG is not a photo; types the bytes cannot show are believed.
    expect(contentType(new TextEncoder().encode('<html>'), 'image/jpeg')).toBe('application/octet-stream');
    expect(contentType(bytes(1, 2), 'text/csv; charset=utf-8')).toBe('text/csv');
    expect(contentType(bytes(1, 2), 'audio/mpeg')).toBe('audio/mpeg');
    expect(contentType(bytes(1, 2))).toBe('application/octet-stream');
  });

  it('shows file arguments to the person who approves a call by name, type and size', async () => {
    const files = store.forWorkspace(mine);
    const kept = await files.put({
      data: bytes(0xff, 0xd8, 0xff, 4),
      name: 'receipt.jpg',
      mimeType: 'image/jpeg',
    });
    const pdf = Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(3000)]).toString('base64');
    expect(
      await describeFileArguments({ chat: 'c1', text: 'Hi', file_id: kept.id, file_base64: pdf }, files),
    ).toEqual({
      chat: 'c1',
      text: 'Hi',
      file_id: 'receipt.jpg · image/jpeg · 1 KB',
      file_base64: 'application/pdf · 3 KB',
    });
    expect(await describeFileArguments({ file_id: 'file_gone', file_base64: '***' }, files)).toEqual({
      file_id: 'file_gone (not kept)',
      file_base64: 'not valid base64',
    });
    expect(await describeFileArguments({ text: 'no files' })).toEqual({ text: 'no files' });
  });

  it('fits a file to what the messenger shows: other photos go as documents, too large is refused', () => {
    const MB = 1_048_576;
    const rules: FileRules = {
      maxBytes: 100 * MB,
      photo: { maxBytes: 5 * MB, mimeTypes: ['image/jpeg', 'image/png'] },
      audio: { maxBytes: 16 * MB },
    };
    const photo = { kind: 'photo', mimeType: 'image/jpeg', size: MB, fileId: 'file_a' } as const;
    expect(fitFile(photo, rules, 'WhatsApp')).toEqual(photo);
    expect(fitFile({ ...photo, mimeType: 'image/webp' }, rules, 'WhatsApp').kind).toBe('document');
    expect(fitFile({ ...photo, size: 6 * MB }, rules, 'WhatsApp').kind).toBe('document');
    // A link the messenger fetches has no size yet: only its type is checked.
    expect(
      fitFile({ kind: 'photo', url: 'https://x.example/a.png', mimeType: 'image/png' }, rules, 'WhatsApp')
        .kind,
    ).toBe('photo');
    // No rule for a kind, or no type in the rule: as asked.
    expect(fitFile({ kind: 'video', size: 90 * MB }, rules, 'WhatsApp').kind).toBe('video');
    expect(fitFile({ kind: 'audio', mimeType: 'audio/flac', size: MB }, rules, 'WhatsApp').kind).toBe(
      'audio',
    );
    expect(() => fitFile({ kind: 'document', size: 101 * MB }, rules, 'WhatsApp')).toThrow(
      'The file is 101 MB; WhatsApp sends files up to 100 MB.',
    );
  });

  it('does not retry links to private addresses, which the network policy never allows', async () => {
    const policy = createNetworkPolicy({ allowPrivateNetwork: false });
    try {
      for (const url of ['https://127.0.0.1/photo.jpg', 'https://localhost/photo.jpg']) {
        const error = await downloadForUpload(policy.fetch, url, { maxBytes: 1000 }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DeliveryError);
        expect(error).toMatchObject({ kind: 'rejected', message: expect.stringMatching(/private network/) });
      }
    } finally {
      await policy.close();
    }
  });
});
