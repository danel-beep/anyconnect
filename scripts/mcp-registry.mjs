// Publishes server.json to the official MCP Registry (registry.modelcontextprotocol.io) under the
// domain namespace (com.manyplug/... → manyplug.com), with HTTP authentication: the hub serves the
// public key at /.well-known/mcp-registry-auth (env WELL_KNOWN_MCP_REGISTRY_AUTH) and this script
// signs with the private key. Same protocol as the official `mcp-publisher login http`.
//
//   node scripts/mcp-registry.mjs keygen    new key pair: the record for the hub, the key for publish
//   MCP_REGISTRY_PRIVATE_KEY=<hex> node scripts/mcp-registry.mjs publish
//
// `publish` does nothing when this name and version are already in the registry. See docs/DIRECTORIES.md.
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const REGISTRY = process.env.MCP_REGISTRY_URL ?? 'https://registry.modelcontextprotocol.io';
const command = process.argv[2];

if (command === 'keygen') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  console.log(`WELL_KNOWN_MCP_REGISTRY_AUTH=v=MCPv1; k=ed25519; p=${pub}`);
  console.log(`MCP_REGISTRY_PRIVATE_KEY=${seed}`);
  console.log('\nSet the first on the hub (it is public), keep the second secret.');
} else if (command === 'publish') {
  await publish();
} else {
  console.error('Usage: node scripts/mcp-registry.mjs keygen | publish');
  process.exit(2);
}

async function publish() {
  const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
  const [namespace] = server.name.split('/');
  const domain = namespace.split('.').reverse().join('.');

  const existing = await fetch(
    `${REGISTRY}/v0/servers/${encodeURIComponent(server.name)}/versions/${encodeURIComponent(server.version)}`,
  );
  if (existing.ok) {
    console.log(`${server.name} ${server.version} is already published.`);
    return;
  }

  const hex = process.env.MCP_REGISTRY_PRIVATE_KEY?.trim();
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
    console.error('MCP_REGISTRY_PRIVATE_KEY must be the 64-character hex key from `keygen`.');
    process.exit(1);
  }
  // PKCS#8 wrapper for a raw Ed25519 seed.
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(hex, 'hex'),
  ]);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const signature = sign(null, Buffer.from(timestamp), key).toString('hex');

  const auth = await fetch(`${REGISTRY}/v0/auth/http`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ domain, timestamp, signed_timestamp: signature }),
  });
  if (!auth.ok) {
    console.error(`Sign-in to the registry failed (${auth.status}): ${await auth.text()}`);
    console.error(
      `Check that https://${domain}/.well-known/mcp-registry-auth serves the matching public key.`,
    );
    process.exit(1);
  }
  const { registry_token: token } = await auth.json();

  const response = await fetch(`${REGISTRY}/v0/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(server),
  });
  const body = await response.text();
  if (!response.ok) {
    console.error(`Publishing failed (${response.status}): ${body}`);
    process.exit(1);
  }
  console.log(`Published ${server.name} ${server.version}.`);
}
