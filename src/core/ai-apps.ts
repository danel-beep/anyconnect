/**
 * Well-known AI apps, recognised by hosts they control: the host of their Client ID Metadata
 * Document or of their https redirect URIs. Used for the "known app" badge on the consent screen,
 * for naming AI clients and for the directory rules of each app (`hub/client-policies.ts`).
 */
const KNOWN_HOSTS: Record<string, string> = {
  'claude.ai': 'Claude',
  'claude.com': 'Claude',
  'chatgpt.com': 'ChatGPT',
  'chat.openai.com': 'ChatGPT',
  'platform.openai.com': 'OpenAI',
};

export function knownClientName(host: string): string | undefined {
  return KNOWN_HOSTS[host.toLowerCase()];
}

/**
 * The known app an OAuth client belongs to, or `undefined`. A metadata-document client is the app
 * of its document's host; a registered client is a known app only when every https redirect URI it
 * registered belongs to that one app (tokens can only ever reach that app).
 */
export function knownAppOfClient(client: {
  id: string;
  registrationType: string;
  redirectUris: readonly string[];
}): string | undefined {
  if (client.registrationType === 'metadata_document') {
    try {
      return knownClientName(new URL(client.id).host);
    } catch {
      return undefined;
    }
  }
  const apps = new Set<string | undefined>();
  for (const uri of client.redirectUris) {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return undefined;
    }
    if (url.protocol !== 'https:') return undefined;
    apps.add(knownClientName(url.host));
  }
  const [app] = [...apps];
  return apps.size === 1 ? app : undefined;
}
