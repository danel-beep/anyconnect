import { createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  type AttachmentKind,
  DeliveryError,
  type DirectTransport,
  type InboundAttachment,
  type InboundMessage,
  type MessagingPort,
} from '../messaging.js';
import { messengerActions, messengerUiTexts, pacingConfig } from '../messaging-actions.js';
import { deliveryFetch, readJson, secretsEqual } from '../messaging-http.js';
import { type AccountContext, ConnectorError, defineConnector } from '../sdk.js';

const config = z.object({
  mode: z
    .enum(['cloud'])
    .default('cloud')
    .describe('How the number is connected: cloud = the official WhatsApp Cloud API (Meta)'),
  phoneNumberId: z
    .string()
    .trim()
    .regex(/^\d{5,25}$/, 'digits only')
    .optional()
    .describe('Phone number ID from Meta'),
  wabaId: z
    .string()
    .trim()
    .regex(/^\d{5,25}$/, 'digits only')
    .optional()
    .describe('WhatsApp Business Account ID: the hub then subscribes its webhook itself'),
  graphApiUrl: z
    .url({ protocol: /^https?$/ })
    .default('https://graph.facebook.com')
    .describe('Graph API address'),
  apiVersion: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v23.0')
    .describe('Graph API version'),
  pacing: pacingConfig.optional(),
});

const credentials = z.object({
  accessToken: z.string().trim().min(20).optional().describe('Permanent access token of a Meta system user'),
  appSecret: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{32}$/i, 'expected the 32-character App Secret')
    .optional()
    .describe('App Secret of the Meta app (verifies webhook signatures)'),
});

type Config = z.output<typeof config>;
type Credentials = z.output<typeof credentials>;
type Ctx = AccountContext<Config, Credentials>;

function graph(ctx: Ctx, path: string): string {
  return `${ctx.config.graphApiUrl.replace(/\/+$/, '')}/${ctx.config.apiVersion}/${path}`;
}

function token(ctx: Ctx): string {
  if (!ctx.credentials.accessToken)
    throw new ConnectorError('auth', 'The access token is not set for this account.');
  return ctx.credentials.accessToken;
}

function phoneNumberId(ctx: Ctx): string {
  if (!ctx.config.phoneNumberId)
    throw new ConnectorError('invalid_input', 'Phone number ID is not set for this account.');
  return ctx.config.phoneNumberId;
}

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } };
}

/** Maps Cloud API error codes (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes). */
function graphError(status: number, body: GraphError): DeliveryError {
  const code = body.error?.code;
  const message =
    [body.error?.message, body.error?.error_data?.details].filter(Boolean).join(': ') || `HTTP ${status}`;
  if (code === 190 || status === 401)
    return new DeliveryError('auth', `Meta rejected the access token: ${message}`);
  if (code === 131047) {
    return new DeliveryError(
      'rejected',
      'More than 24 hours passed since the person last wrote: WhatsApp only allows an approved template now.',
    );
  }
  if (code === 131048 || code === 368) return new DeliveryError('spam_warning', message);
  if (code === 130429 || code === 131056 || code === 80007 || code === 4 || status === 429) {
    return new DeliveryError('rate_limited', message, { retryAfterSeconds: code === 131056 ? 6 : 60 });
  }
  if (status >= 500 || code === 1 || code === 2 || code === 131000)
    return new DeliveryError('transient', message);
  return new DeliveryError('rejected', message);
}

async function callGraph<T>(ctx: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  const response = await deliveryFetch(ctx.fetch, graph(ctx, path), {
    method,
    headers: {
      authorization: `Bearer ${token(ctx)}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: ctx.signal,
  });
  const json = await readJson(response);
  if (!response.ok) throw graphError(response.status, json as GraphError);
  return json as T;
}

async function callGraphForAction<T>(ctx: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await callGraph<T>(ctx, method, path, body);
  } catch (error) {
    if (!(error instanceof DeliveryError)) throw error;
    const kind = error.kind === 'auth' ? 'auth' : error.kind === 'rejected' ? 'invalid_input' : 'upstream';
    throw new ConnectorError(kind, error.message, { cause: error });
  }
}

// ---------------------------------------------------------------------------
// Webhook payloads
// ---------------------------------------------------------------------------

interface WaMedia {
  id: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
}
interface WaMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: WaMedia;
  video?: WaMedia;
  audio?: WaMedia & { voice?: boolean };
  document?: WaMedia;
  sticker?: WaMedia;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: { name?: { formatted_name?: string }; phones?: { phone?: string }[] }[];
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  reaction?: { emoji?: string; message_id?: string };
  context?: { id?: string };
}
interface WaValue {
  messaging_product?: string;
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: { wa_id: string; profile?: { name?: string } }[];
  messages?: WaMessage[];
}
interface WaWebhook {
  object?: string;
  entry?: { changes?: { field?: string; value?: WaValue }[] }[];
}

function waAttachments(message: WaMessage): InboundAttachment[] {
  const out: InboundAttachment[] = [];
  const add = (kind: AttachmentKind, media: WaMedia | undefined) => {
    if (!media) return;
    out.push({
      externalId: media.id,
      kind,
      ...(media.filename ? { name: media.filename } : {}),
      ...(media.mime_type ? { mimeType: media.mime_type.split(';')[0]! } : {}),
      locator: { mediaId: media.id },
    });
  };
  add('photo', message.image);
  add('video', message.video);
  add(message.audio?.voice ? 'voice' : 'audio', message.audio);
  add('document', message.document);
  add('sticker', message.sticker);
  return out;
}

function waText(message: WaMessage): string {
  const media = message.image ?? message.video ?? message.document;
  const parts = [
    message.text?.body,
    media?.caption,
    message.button?.text,
    message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title,
    message.reaction?.emoji ? `[reaction ${message.reaction.emoji}]` : undefined,
    message.location
      ? `[location ${message.location.latitude}, ${message.location.longitude}${message.location.name ? ` ${message.location.name}` : ''}]`
      : undefined,
    ...(message.contacts ?? []).map(
      (c) => `[contact ${c.name?.formatted_name ?? ''} ${c.phones?.[0]?.phone ?? ''}]`,
    ),
  ];
  return parts.filter(Boolean).join(' ');
}

export function cloudWebhookToMessages(
  payload: WaWebhook,
  ownPhoneNumberId: string | undefined,
): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (change.field !== 'messages' || !value?.messages) continue;
      if (
        ownPhoneNumberId &&
        value.metadata?.phone_number_id &&
        value.metadata.phone_number_id !== ownPhoneNumberId
      ) {
        continue; // Another number of the same business account.
      }
      for (const message of value.messages) {
        const name = value.contacts?.find((c) => c.wa_id === message.from)?.profile?.name;
        out.push({
          chat: { externalId: message.from, kind: 'direct', title: name ?? `+${message.from}` },
          externalId: message.id,
          direction: 'in',
          sentAt: new Date(Number(message.timestamp) * 1000),
          sender: { externalId: `+${message.from}`, ...(name ? { name } : {}) },
          text: waText(message),
          ...(message.context?.id ? { replyToExternalId: message.context.id } : {}),
          attachments: waAttachments(message),
        });
      }
    }
  }
  return out;
}

function verifySignature(body: string, header: string | undefined, appSecret: string): boolean {
  const expected = `sha256=${createHmac('sha256', appSecret).update(body, 'utf8').digest('hex')}`;
  return secretsEqual(header?.toLowerCase(), expected);
}

const cloudTransport: DirectTransport<Config, Credentials> = {
  kind: 'direct',
  // No idempotency key in the Cloud API: an interrupted send is reported, never repeated.
  idempotentSend: false,

  async send(job, ctx) {
    if (job.kind === 'mark_read') {
      if (!job.upToExternalId) return undefined;
      await callGraph(ctx, 'POST', `${phoneNumberId(ctx)}/messages`, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: job.upToExternalId,
      });
      return undefined;
    }
    const result = await callGraph<{ messages?: { id: string }[] }>(
      ctx,
      'POST',
      `${phoneNumberId(ctx)}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: job.chat.externalId,
        type: 'text',
        text: { body: job.text, preview_url: false },
        ...(job.replyToExternalId ? { context: { message_id: job.replyToExternalId } } : {}),
      },
    );
    const id = result.messages?.[0]?.id;
    if (!id) throw new DeliveryError('rejected', 'WhatsApp did not return a message id');
    return { externalId: id, sentAt: new Date() };
  },

  async resolveRecipient(to) {
    const digits = to.replace(/[\s()+-]/g, '');
    if (!/^\d{7,15}$/.test(digits)) {
      throw new ConnectorError(
        'invalid_input',
        'Pass the phone number in international format, e.g. +79991234567.',
      );
    }
    return { externalId: digits, kind: 'direct', title: `+${digits}` };
  },

  async download(attachment, ctx) {
    const mediaId =
      (attachment.locator as { mediaId?: string } | undefined)?.mediaId ?? attachment.externalId;
    const media = await callGraphForAction<{ url?: string; mime_type?: string }>(ctx, 'GET', mediaId);
    if (!media.url)
      throw new ConnectorError(
        'not_found',
        'This file is no longer available (WhatsApp keeps media for 30 days).',
      );
    const response = await ctx.fetch(media.url, {
      headers: { authorization: `Bearer ${token(ctx)}` },
      signal: ctx.signal,
    });
    if (!response.ok)
      throw new ConnectorError('upstream', `WhatsApp media download failed (${response.status})`);
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      mimeType: (media.mime_type ?? response.headers.get('content-type') ?? 'application/octet-stream').split(
        ';',
      )[0]!,
    };
  },

  webhook: {
    async handle(request, ctx, hook) {
      if (request.method === 'GET') {
        // Meta's subscription handshake.
        if (
          request.query['hub.mode'] === 'subscribe' &&
          secretsEqual(request.query['hub.verify_token'], hook.secret)
        ) {
          return { status: 200, body: request.query['hub.challenge'] ?? '', contentType: 'text/plain' };
        }
        return { status: 403 };
      }
      if (request.method !== 'POST') return { status: 405 };
      const appSecret = ctx.credentials.appSecret;
      if (!appSecret || !verifySignature(request.body, request.headers['x-hub-signature-256'], appSecret)) {
        return { status: 401 };
      }
      let payload: WaWebhook;
      try {
        payload = JSON.parse(request.body) as WaWebhook;
      } catch {
        return { status: 400 };
      }
      const messages = cloudWebhookToMessages(payload, ctx.config.phoneNumberId);
      if (messages.length) await hook.ingest(messages);
      return { status: 200, body: 'ok' };
    },
  },
};

export function createWhatsAppConnector(port: MessagingPort) {
  return defineConnector({
    id: 'whatsapp',
    name: 'WhatsApp',
    description:
      'WhatsApp messages: read and search chats, see what is new, reply and write. Any number of numbers.',
    version: '1.0.0',
    homepage: 'https://www.whatsapp.com',
    instructions:
      "WhatsApp tools read from the hub's synced copy of the chats. Find chats with whatsapp_list_chats, then read or send by chat id. " +
      'Cloud API numbers can reply freely only within 24 hours after the person last wrote. Before writing to someone new, ask the user.',
    config,
    credentials,
    messenger: {
      transport: () => cloudTransport,
      pacing: () => ({
        perMinute: 30,
        perHour: 1_000,
        perDay: 10_000,
        minGapMs: 200,
        maxGapMs: 800,
        typing: false,
      }),
    },
    async test(ctx) {
      const number = await callGraphForAction<{ display_phone_number?: string; verified_name?: string }>(
        ctx,
        'GET',
        `${phoneNumberId(ctx)}?fields=display_phone_number,verified_name`,
      );
      if (!ctx.credentials.appSecret) {
        return { ok: false, message: 'Set the App Secret: without it incoming messages cannot be verified.' };
      }
      const hook = port.forAccount(ctx.account.id).webhook();
      if (ctx.config.wabaId) {
        await callGraphForAction(ctx, 'POST', `${ctx.config.wabaId}/subscribed_apps`, {
          override_callback_uri: hook.url,
          verify_token: hook.secret,
        });
      }
      return {
        ok: true,
        identity: number.display_phone_number ?? number.verified_name ?? phoneNumberId(ctx),
        ...(ctx.config.wabaId
          ? {}
          : { message: `Set the webhook in Meta: URL ${hook.url}, verify token from the account page.` }),
      };
    },
    ui: {
      primaryFields: ['phoneNumberId', 'wabaId', 'accessToken', 'appSecret'],
      locales: {
        ru: {
          description:
            'Номер WhatsApp Business через официальный Cloud API от Meta: чаты, поиск, ответы клиентам.',
          setup: {
            form: {
              summary: 'Приложение Meta с продуктом WhatsApp и постоянный токен. Около 15 минут.',
              steps: [
                {
                  text: 'Создайте приложение типа Business и добавьте в него продукт WhatsApp.',
                  link: { label: 'Открыть Meta for Developers', url: 'https://developers.facebook.com/apps' },
                },
                {
                  text: 'В WhatsApp → API Setup скопируйте Phone number ID и WhatsApp Business Account ID.',
                },
                {
                  text: 'В настройках компании создайте системного пользователя, выдайте ему права whatsapp_business_messaging и whatsapp_business_management и создайте постоянный токен.',
                  link: { label: 'Открыть Business Settings', url: 'https://business.facebook.com/settings' },
                },
                { text: 'В приложении: Settings → Basic → App Secret. Вставьте все значения в форму.' },
              ],
              tips: [
                'Вне 24 часов после последнего сообщения клиента WhatsApp разрешает писать только шаблонами.',
                'Хаб сам подписывает вебхук, если указан WhatsApp Business Account ID.',
              ],
            },
          },
          prompts: [
            'Какие клиенты написали в WhatsApp сегодня и ждут ответа?',
            'Найди сообщения про возврат за неделю.',
            'Ответь Ивану, что доставка будет завтра.',
          ],
          fields: {
            mode: { label: 'Как подключить', options: { cloud: 'Cloud API (Meta)' } },
            phoneNumberId: { label: 'Phone number ID' },
            wabaId: { label: 'WhatsApp Business Account ID', hint: 'Тогда хаб сам подпишет вебхук.' },
            graphApiUrl: { label: 'Адрес Graph API' },
            apiVersion: { label: 'Версия Graph API' },
            accessToken: { label: 'Постоянный токен' },
            appSecret: { label: 'App Secret', hint: 'Нужен, чтобы проверять, что сообщения пришли от Meta.' },
            pacing: texts.ru.pacing,
          },
          actions: texts.ru.actions,
        },
        en: {
          description:
            'A WhatsApp Business number through the official Cloud API by Meta: chats, search, replies.',
          setup: {
            form: {
              summary: 'A Meta app with the WhatsApp product and a permanent token. About 15 minutes.',
              steps: [
                {
                  text: 'Create a Business type app and add the WhatsApp product to it.',
                  link: { label: 'Open Meta for Developers', url: 'https://developers.facebook.com/apps' },
                },
                {
                  text: 'In WhatsApp → API Setup copy the Phone number ID and the WhatsApp Business Account ID.',
                },
                {
                  text: 'In Business Settings create a system user, give it whatsapp_business_messaging and whatsapp_business_management and generate a permanent token.',
                  link: { label: 'Open Business Settings', url: 'https://business.facebook.com/settings' },
                },
                { text: 'In the app: Settings → Basic → App Secret. Paste all values into the form.' },
              ],
              tips: [
                'More than 24 hours after the customer last wrote, WhatsApp only allows template messages.',
                'With the WhatsApp Business Account ID set, the hub subscribes the webhook itself.',
              ],
            },
          },
          prompts: [
            'Which customers wrote on WhatsApp today and still wait for an answer?',
            'Find messages about refunds from this week.',
            'Tell Ivan the delivery comes tomorrow.',
          ],
          fields: {
            mode: { label: 'How to connect', options: { cloud: 'Cloud API (Meta)' } },
            phoneNumberId: { label: 'Phone number ID' },
            wabaId: {
              label: 'WhatsApp Business Account ID',
              hint: 'The hub then subscribes the webhook itself.',
            },
            graphApiUrl: { label: 'Graph API address' },
            apiVersion: { label: 'Graph API version' },
            accessToken: { label: 'Permanent token' },
            appSecret: { label: 'App Secret', hint: 'Used to check that messages really come from Meta.' },
            pacing: texts.en.pacing,
          },
          actions: texts.en.actions,
        },
      },
    },
    actions: (action) => messengerActions(action, port, { serviceName: 'WhatsApp' }),
  });
}

const texts = messengerUiTexts('WhatsApp');
