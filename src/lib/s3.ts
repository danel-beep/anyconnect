import { createHash, createHmac } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';

/**
 * A minimal client for S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO…):
 * put, get, list and delete with AWS Signature V4, path-style URLs. Bodies stream from and to
 * files, so large objects never sit in memory. No SDK: four calls do not justify its weight.
 */
export interface S3Config {
  /** e.g. https://<account>.r2.cloudflarestorage.com or https://s3.eu-central-1.amazonaws.com */
  endpoint: string;
  bucket: string;
  /** `auto` for R2. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface S3Object {
  key: string;
  size: number;
  lastModified: Date;
}

export class S3Error extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'S3Error';
  }
}

const EMPTY_HASH = createHash('sha256').update('').digest('hex');

export class S3Client {
  private readonly endpoint: URL;

  constructor(
    private readonly config: S3Config,
    private readonly options: { now?: () => Date; timeoutMs?: number } = {},
  ) {
    this.endpoint = new URL(config.endpoint);
  }

  /** Uploads a file (single PUT: up to 5 GB). */
  async putFile(key: string, path: string, contentType = 'application/octet-stream'): Promise<void> {
    // The size sent and the bytes streamed come from the same open file.
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      await this.send('PUT', key, {
        headers: { 'content-type': contentType, 'content-length': String(size) },
        payloadHash: 'UNSIGNED-PAYLOAD',
        body: () => handle.createReadStream({ autoClose: false }),
      });
    } finally {
      await handle.close();
    }
  }

  /** Downloads an object into a file. */
  async getFile(key: string, path: string): Promise<void> {
    await this.send('GET', key, { sink: path });
  }

  async delete(key: string): Promise<void> {
    await this.send('DELETE', key);
  }

  /** Every object under `prefix` (follows continuation tokens). */
  async list(prefix: string): Promise<S3Object[]> {
    const objects: S3Object[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (token) query['continuation-token'] = token;
      const xml = await this.send('GET', undefined, { query });
      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const item = match[1]!;
        const key = xmlValue(item, 'Key');
        if (!key) continue;
        objects.push({
          key,
          size: Number(xmlValue(item, 'Size') ?? 0),
          lastModified: new Date(xmlValue(item, 'LastModified') ?? 0),
        });
      }
      token = xmlValue(xml, 'IsTruncated') === 'true' ? xmlValue(xml, 'NextContinuationToken') : undefined;
    } while (token);
    return objects;
  }

  private async send(
    method: 'GET' | 'PUT' | 'DELETE',
    key: string | undefined,
    options: {
      query?: Record<string, string>;
      headers?: Record<string, string>;
      payloadHash?: string;
      body?: () => NodeJS.ReadableStream;
      /** Write the response body to this file instead of returning it. */
      sink?: string;
    } = {},
  ): Promise<string> {
    const path = `${this.endpoint.pathname.replace(/\/$/, '')}/${encodePath(this.config.bucket)}${key === undefined ? '' : `/${encodePath(key)}`}`;
    const query = options.query ?? {};
    const headers = signV4({
      method,
      host: this.endpoint.host,
      path,
      query,
      headers: options.headers ?? {},
      payloadHash: options.payloadHash ?? EMPTY_HASH,
      date: (this.options.now ?? (() => new Date()))(),
      region: this.config.region,
      service: 's3',
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
    });
    const search = canonicalQuery(query);
    const transport = this.endpoint.protocol === 'http:' ? http : https;
    return new Promise<string>((resolve, reject) => {
      const request = transport.request(
        {
          method,
          protocol: this.endpoint.protocol,
          hostname: this.endpoint.hostname,
          port: this.endpoint.port || undefined,
          path: search ? `${path}?${search}` : path,
          headers,
          timeout: this.options.timeoutMs ?? 10 * 60_000,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300 && options.sink) {
            pipeline(response, createWriteStream(options.sink)).then(() => resolve(''), reject);
            return;
          }
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (status >= 200 && status < 300) return resolve(text);
            const code = xmlValue(text, 'Code') ?? `HTTP ${status}`;
            const message = xmlValue(text, 'Message');
            reject(new S3Error(`Storage answered ${code}${message ? `: ${message}` : ''}`, status));
          });
        },
      );
      request.on('timeout', () => request.destroy(new Error('Storage did not answer in time')));
      request.on('error', reject);
      if (options.body) {
        const body = options.body();
        body.on('error', (error) => request.destroy(error as Error));
        body.pipe(request);
      } else {
        request.end();
      }
    });
  }
}

function xmlValue(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeXml(match[1]!) : undefined;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** RFC 3986 encoding, as Signature V4 requires. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodePath(path: string): string {
  return path.split('/').map(encode).join('/');
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((key) => `${encode(key)}=${encode(query[key]!)}`)
    .join('&');
}

const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

/**
 * AWS Signature Version 4 for one request: returns the headers to send (the given ones plus
 * host, x-amz-date, x-amz-content-sha256 and authorization). `path` is already URI-encoded.
 */
export function signV4(input: {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  payloadHash: string;
  date: Date;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Record<string, string> {
  const amzDate = input.date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: input.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
  };
  // content-length may be changed by proxies; it is not needed in the signature.
  const signed = Object.keys(headers)
    .filter((name) => name !== 'content-length')
    .sort();
  const canonicalRequest = [
    input.method,
    input.path,
    canonicalQuery(input.query),
    ...signed.map((name) => `${name}:${headers[name]}`),
    '',
    signed.join(';'),
    input.payloadHash,
  ].join('\n');
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`;
  return headers;
}
