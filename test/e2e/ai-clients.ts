import {
  Client,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import type { FakeInternet } from './fake-internet.js';

/**
 * The AI clients people connect to the hub, as the hub sees them: how each one identifies itself
 * (a Client ID Metadata Document it hosts, or dynamic client registration), the redirect URI it
 * uses, the MCP protocol it speaks and what it can do in the chat.
 *
 * Registration shapes are copied from the clients' published metadata documents and registration
 * requests. Protocol and capabilities are representative of each client today (2025-era clients
 * are stateless and cannot be asked in the chat); when a client changes, change its entry here and
 * every end-to-end test follows. New client = one entry.
 */
export interface AiClientProfile {
  id: string;
  /** How the client introduces itself. */
  identity:
    | { kind: 'metadata_document'; url: string; document: Record<string, unknown> }
    | { kind: 'registration'; body: Record<string, unknown> };
  /** The redirect URI it sends to /oauth/authorize (loopback ports vary per run). */
  redirectUrl: string;
  /** 2025-era stateless MCP, or the 2026-07-28 revision negotiated by the SDK. */
  protocol: 'legacy' | 'modern';
  /** Declares MCP elicitation (the hub can ask the user in the chat). */
  elicitation: boolean;
  /** `_meta` the client sends with every tool call. */
  callMeta?: Record<string, unknown>;
  /** The name the hub gives this app on the consent screen and in access rules. */
  expectedName: string;
  /** What the consent screen tells the user about this app. */
  consent: {
    /** Host that proves the app's identity (its metadata document). */
    verifiedDomain?: string;
    /** "Known AI app" badge (a well-known app returning to its own https site). */
    knownApp: boolean;
    /** Caution shown before approving. */
    warning?: 'loopback' | 'unknown';
  };
  /** Most tools the client accepts in tools/list. */
  maxTools?: number;
}

const CLAUDE_DOCUMENT = {
  client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
  client_name: 'Claude',
  client_uri: 'https://claude.ai',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

const CLAUDE_CODE_DOCUMENT = {
  client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

export const AI_CLIENTS: AiClientProfile[] = [
  {
    id: 'claude',
    identity: { kind: 'metadata_document', url: CLAUDE_DOCUMENT.client_id, document: CLAUDE_DOCUMENT },
    redirectUrl: 'https://claude.ai/api/mcp/auth_callback',
    protocol: 'legacy',
    elicitation: false,
    expectedName: 'Claude',
    consent: { verifiedDomain: 'claude.ai', knownApp: true },
  },
  {
    id: 'claude-code',
    identity: {
      kind: 'metadata_document',
      url: CLAUDE_CODE_DOCUMENT.client_id,
      document: CLAUDE_CODE_DOCUMENT,
    },
    redirectUrl: 'http://localhost:54123/callback',
    protocol: 'modern',
    elicitation: true,
    expectedName: 'Claude Code',
    consent: { verifiedDomain: 'claude.ai', knownApp: false, warning: 'loopback' },
  },
  {
    id: 'chatgpt',
    identity: {
      kind: 'registration',
      body: {
        client_name: 'ChatGPT',
        redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      },
    },
    redirectUrl: 'https://chatgpt.com/connector_platform_oauth_redirect',
    protocol: 'legacy',
    elicitation: false,
    callMeta: { 'openai/subject': 'chatgpt-user-7f3a', 'openai/locale': 'en-US' },
    expectedName: 'ChatGPT',
    consent: { knownApp: true },
  },
  {
    id: 'cursor',
    identity: {
      kind: 'registration',
      body: {
        client_name: 'Cursor',
        redirect_uris: ['cursor://anysphere.cursor-retrieval/oauth/user-manyplug/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    },
    redirectUrl: 'cursor://anysphere.cursor-retrieval/oauth/user-manyplug/callback',
    protocol: 'legacy',
    elicitation: false,
    expectedName: 'Cursor',
    consent: { knownApp: false, warning: 'unknown' },
    maxTools: 40,
  },
  {
    id: 'vscode',
    identity: {
      kind: 'registration',
      body: {
        client_name: 'Visual Studio Code',
        client_uri: 'https://code.visualstudio.com',
        grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
        response_types: ['code'],
        redirect_uris: [
          'https://insiders.vscode.dev/redirect',
          'https://vscode.dev/redirect',
          'http://localhost',
          'http://127.0.0.1',
          'http://localhost:33418',
          'http://127.0.0.1:33418',
        ],
        token_endpoint_auth_method: 'none',
      },
    },
    redirectUrl: 'http://127.0.0.1:33418/',
    protocol: 'modern',
    elicitation: true,
    expectedName: 'Visual Studio Code',
    consent: { knownApp: false, warning: 'loopback' },
  },
  {
    id: 'gemini-cli',
    identity: {
      kind: 'registration',
      body: {
        client_name: 'Gemini CLI MCP Client',
        redirect_uris: ['http://localhost:7777/oauth/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        code_challenge_method: ['S256'],
      },
    },
    redirectUrl: 'http://localhost:7777/oauth/callback',
    protocol: 'legacy',
    elicitation: false,
    expectedName: 'Gemini CLI MCP Client',
    consent: { knownApp: false, warning: 'loopback' },
  },
  {
    id: 'codex',
    identity: {
      kind: 'registration',
      body: {
        client_name: 'Codex',
        redirect_uris: ['http://127.0.0.1:41234/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    },
    // A new loopback port on every run: allowed for loopback redirects (RFC 8252).
    redirectUrl: 'http://127.0.0.1:50999/callback',
    protocol: 'legacy',
    elicitation: false,
    expectedName: 'Codex',
    consent: { knownApp: false, warning: 'loopback' },
  },
];

/** Serves the clients' metadata documents at their URLs (claude.ai, ...). */
export function serveClientDocuments(internet: FakeInternet, clients = AI_CLIENTS): void {
  const byHost = new Map<string, Map<string, Record<string, unknown>>>();
  for (const client of clients) {
    if (client.identity.kind !== 'metadata_document') continue;
    const url = new URL(client.identity.url);
    if (!byHost.has(url.host)) byHost.set(url.host, new Map());
    byHost.get(url.host)!.set(url.pathname, client.identity.document);
  }
  for (const [host, documents] of byHost) {
    internet.serve(host, (request) => {
      const document = documents.get(new URL(request.url).pathname);
      return document
        ? Response.json(document, { headers: { 'cache-control': 'max-age=600' } })
        : new Response('not found', { status: 404 });
    });
  }
}

type Stored = Parameters<NonNullable<OAuthClientProvider['saveClientInformation']>>[0];
type Tokens = Parameters<OAuthClientProvider['saveTokens']>[0];

/** The OAuth side of an MCP client: keeps its registration, tokens and PKCE verifier in memory. */
export class MemoryOAuthProvider implements OAuthClientProvider {
  client?: Stored;
  savedTokens?: Tokens;
  verifier = '';
  authorizationUrl?: URL;
  clientMetadataUrl?: string;
  private discovery?: unknown;

  constructor(
    readonly redirectUrl: string,
    private readonly metadata: Record<string, unknown>,
    options: { clientMetadataUrl?: string } = {},
  ) {
    if (options.clientMetadataUrl) this.clientMetadataUrl = options.clientMetadataUrl;
  }

  static for(profile: AiClientProfile): MemoryOAuthProvider {
    return profile.identity.kind === 'metadata_document'
      ? new MemoryOAuthProvider(profile.redirectUrl, profile.identity.document, {
          clientMetadataUrl: profile.identity.url,
        })
      : new MemoryOAuthProvider(profile.redirectUrl, profile.identity.body);
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.metadata as unknown as OAuthClientMetadata;
  }
  clientInformation() {
    return this.client;
  }
  saveClientInformation(info: Stored) {
    this.client = info;
  }
  tokens() {
    return this.savedTokens;
  }
  saveTokens(tokens: Tokens) {
    this.savedTokens = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
  saveDiscoveryState(state: unknown) {
    this.discovery = state;
  }
  discoveryState() {
    return this.discovery as never;
  }
}

/** What the user answers when the hub asks in the chat (MCP elicitation). */
export type ChatAnswer = 'approve' | 'decline' | 'cancel';

/**
 * One AI client connected to the hub through the official MCP SDK, the way the real app would be:
 * OAuth discovery from the 401, sign-in in a browser window (`signIn` walks it and returns the
 * redirect back to the app), then tool calls with the client's own `_meta` and capabilities.
 */
export class SimulatedAiClient {
  readonly provider: MemoryOAuthProvider;
  /** Questions the hub asked in the chat, newest last. */
  readonly questions: string[] = [];
  /** Answers to give, in order; an empty queue declines. */
  readonly answers: ChatAnswer[] = [];
  private client?: Client;

  constructor(
    readonly profile: AiClientProfile,
    private readonly mcpUrl: string,
  ) {
    this.provider = MemoryOAuthProvider.for(profile);
  }

  /** Adds the hub to the app: the 401 starts OAuth, `signIn` is the browser window. */
  async connect(signIn: (authorizationUrl: URL) => Promise<URL>): Promise<this> {
    const probe = new StreamableHTTPClientTransport(new URL(this.mcpUrl), { authProvider: this.provider });
    let unauthorized: unknown;
    try {
      await new Client({ name: this.profile.id, version: '1.0.0' }).connect(probe);
    } catch (error) {
      unauthorized = error;
    }
    if (!(unauthorized instanceof UnauthorizedError)) {
      throw new Error(`expected the hub to ask for sign-in, got ${String(unauthorized)}`);
    }
    if (!this.provider.authorizationUrl) throw new Error('the client was not sent to sign in');
    const callback = await signIn(this.provider.authorizationUrl);
    await probe.finishAuth(callback.searchParams);
    await this.open();
    return this;
  }

  /** Opens an MCP session with the tokens it has (a new chat). */
  async open(): Promise<Client> {
    await this.client?.close();
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), {
      authProvider: this.provider,
    });
    const client = new Client(
      { name: this.profile.id, version: '1.0.0' },
      {
        ...(this.profile.protocol === 'modern' ? { versionNegotiation: { mode: 'auto' as const } } : {}),
        ...(this.profile.elicitation ? { capabilities: { elicitation: { form: {} } } } : {}),
      },
    );
    if (this.profile.elicitation) {
      client.setRequestHandler('elicitation/create', async (request) => {
        this.questions.push(String((request.params as { message: string }).message));
        const answer = this.answers.shift() ?? 'decline';
        return answer === 'approve' ? { action: 'accept', content: { approve: true } } : { action: answer };
      });
    }
    await client.connect(transport);
    this.client = client;
    return client;
  }

  get mcp(): Client {
    if (!this.client) throw new Error(`${this.profile.id} is not connected`);
    return this.client;
  }

  async toolNames(): Promise<string[]> {
    return (await this.mcp.listTools()).tools.map((t) => t.name).sort();
  }

  async call(name: string, args: Record<string, unknown> = {}) {
    const result = await this.mcp.callTool({
      name,
      arguments: args,
      ...(this.profile.callMeta ? { _meta: this.profile.callMeta } : {}),
    });
    return { ...result, text: JSON.stringify(result.content ?? '') };
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }
}
