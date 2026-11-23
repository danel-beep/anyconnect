import { createServer, type Server } from 'node:http';

/** A tiny S3-compatible server: path-style put/get/delete/list, requires a signed request. */
export function fakeS3() {
  const objects = new Map<string, { body: Buffer; modified: Date }>();
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (!String(req.headers.authorization).startsWith('AWS4-HMAC-SHA256 Credential=key/')) {
      res.writeHead(403).end('<Error><Code>AccessDenied</Code><Message>No signature</Message></Error>');
      return;
    }
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    if (bucket !== 'backups') {
      res.writeHead(404).end('<Error><Code>NoSuchBucket</Code></Error>');
      return;
    }
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        objects.set(key, { body: Buffer.concat(chunks), modified: new Date() });
        res.writeHead(200).end();
      });
      return;
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'GET' && key) {
      const object = objects.get(key);
      if (!object) res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
      else res.writeHead(200).end(object.body);
      return;
    }
    // ListObjectsV2, two per page to exercise continuation.
    const prefix = url.searchParams.get('prefix') ?? '';
    const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = Number(url.searchParams.get('continuation-token') ?? 0);
    const page = all.slice(start, start + 2);
    const more = start + 2 < all.length;
    res
      .writeHead(200, { 'content-type': 'application/xml' })
      .end(
        `<?xml version="1.0"?><ListBucketResult><IsTruncated>${more}</IsTruncated>${page
          .map(
            (k) =>
              `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><Size>${objects.get(k)!.body.length}</Size><LastModified>${objects.get(k)!.modified.toISOString()}</LastModified></Contents>`,
          )
          .join(
            '',
          )}${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}</ListBucketResult>`,
      );
  });
  return { server, objects, requests };
}
