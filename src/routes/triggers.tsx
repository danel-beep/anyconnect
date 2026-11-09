import { Hono } from 'hono';
import { z } from 'zod';
import { connectorText } from '../connectors/sdk.js';
import type { Principal } from '../core/principal.js';
import type { TriggerChange, TriggerDo, TriggerWhen } from '../hub/trigger-tools.js';
import { AI_PROVIDER_IDS, AI_PROVIDERS } from '../triggers/ai/providers.js';
import { DEFAULT_DAILY_RUNS, MAX_DAILY_RUNS } from '../triggers/spec.js';
import type { TriggerEvent } from '../triggers/store.js';
import type { Key } from '../web/i18n.js';
import { type AccountOption, AiKeysPage, type TriggerEventView, TriggersPage } from '../web/triggers.js';
import type { AppContext, AppEnv } from './context.js';
import { type AppAuth, appAction, appPage, pageCtx, setFlash, shellInfo, takeFlash } from './page-helpers.js';

const EVENTS_SHOWN = 30;

/** The signed-in user acting on their own workspace from the dashboard. */
const sessionPrincipal = (auth: AppAuth): Principal => ({
  kind: 'session',
  userId: auth.user.id,
  workspaceId: auth.workspace.id,
  scopes: [],
});

/** "Runs per day" with its "No daily limit" box: null means no limit. */
const dailyLimit = (form: Record<string, string>, field: string): number | null => {
  if (form.noLimit === 'on') return null;
  const raw = (form[field] ?? '').trim();
  if (!raw) return null;
  return z.coerce.number().int().min(1).max(MAX_DAILY_RUNS).parse(raw);
};

const TriggerForm = z.object({
  name: z.string().trim().min(1).max(80),
  account: z.string().regex(/^(message|mail):[\w.:@-]{0,200}$/),
  do: z.enum(['check', 'notify', 'tool', 'ai']),
  from: z.string().max(300).default(''),
  text: z.string().max(300).default(''),
  chat: z.string().max(300).default(''),
  subject: z.string().max(300).default(''),
  task: z.string().trim().max(1000).default(''),
  tool: z.string().trim().max(100).default(''),
  args: z.string().trim().max(4000).default(''),
  aiKey: z.string().trim().max(100).default(''),
  instructions: z.string().trim().max(4000).default(''),
  tools: z.string().max(1000).default(''),
});

/** The new-trigger form as the same change the chat tool `manyplug_create_trigger` takes. */
function triggerInput(
  form: Record<string, string>,
): TriggerChange & { name: string; when: TriggerWhen; do: TriggerDo } {
  const input = TriggerForm.parse(form);
  const split = input.account.indexOf(':');
  const when = input.account.slice(0, split) as TriggerWhen;
  const account = input.account.slice(split + 1);
  let args: Record<string, unknown> | undefined;
  if (input.do === 'tool' && input.args) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.args);
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BadArgs();
    args = parsed as Record<string, unknown>;
  }
  const tools = input.tools
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    name: input.name,
    when,
    ...(account ? { account } : {}),
    filter: { from: input.from, text: input.text, chat: input.chat, subject: input.subject },
    do: input.do,
    ...(input.do === 'check' && input.task ? { task: input.task } : {}),
    ...(input.do === 'tool' ? { tool: input.tool, args: args ?? {} } : {}),
    ...(input.do === 'ai'
      ? {
          instructions: input.instructions,
          tools,
          ...(input.aiKey ? { aiKey: input.aiKey } : {}),
          askBeforeRisky: form.askBeforeRisky === 'on',
          notify: form.notify === 'on',
        }
      : {}),
    dailyLimit: dailyLimit(form, 'dailyLimit'),
  };
}

class BadArgs extends Error {}

/** Account picker entries: one per service with several accounts, then each account. */
async function accountOptions(c: AppContext, workspaceId: string): Promise<AccountOption[]> {
  const s = c.get('services');
  const [watchable, connectors] = await Promise.all([
    s.triggers.service.watchable(workspaceId),
    s.connectors.list(workspaceId),
  ]);
  const names = new Map(connectors.map((x) => [x.id, connectorText(x, c.get('locale')).name]));
  const out: AccountOption[] = [];
  for (const when of ['message', 'mail'] as const) {
    const rows = [...watchable[when]].sort(
      (a, b) => a.connectorId.localeCompare(b.connectorId) || a.label.localeCompare(b.label),
    );
    for (const connectorId of new Set(rows.map((r) => r.connectorId))) {
      const service = names.get(connectorId) ?? connectorId;
      const accounts = rows.filter((r) => r.connectorId === connectorId);
      if (accounts.length > 1) out.push({ when, value: connectorId, label: service });
      for (const a of accounts)
        out.push({ when, value: `${a.connectorId}:${a.name}`, label: `${service}: ${a.label}` });
    }
  }
  return out;
}

function eventView(c: AppContext, event: TriggerEvent, names: Map<string, string>): TriggerEventView {
  const t = c.get('t');
  const item = event.item;
  const r = event.result;
  return {
    id: event.id,
    trigger: names.get(event.triggerId) ?? '',
    status: event.status,
    service: item?.service ?? '',
    from: item?.from,
    title: item?.chatTitle ?? item?.subject,
    preview: item?.text ? clipText(item.text, 160) : undefined,
    summary: r.summary ? clipText(r.summary, 600) : undefined,
    note: r.skipped ? t(`triggers.skip.${r.skipped}` as Key) : r.error ? clipText(r.error, 300) : undefined,
    tokens: event.tokens,
    at: event.createdAt,
  };
}

const clipText = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Triggers (`/app/triggers`) and the user's own AI keys (`/app/ai`) in the dashboard. The same
 * operations are chat tools (`manyplug_*_trigger`); keys are set only here, never through a chat.
 * See docs/TRIGGERS.md.
 */
export function triggerRoutes() {
  const app = new Hono<AppEnv>();

  app.get(
    '/app/triggers',
    appPage('/app/triggers', async (c, auth) => {
      const s = c.get('services');
      const ws = auth.workspace.id;
      const [triggers, events, accounts, keys, channels, shell] = await Promise.all([
        s.triggers.service.list(ws),
        s.triggers.service.events(ws, { limit: EVENTS_SHOWN }),
        accountOptions(c, ws),
        s.triggers.keys.list(ws),
        s.notificationChannels.status(auth.user.id),
        shellInfo(c, ws),
      ]);
      const names = new Map(triggers.map((tr) => [tr.id, tr.name]));
      return c.html(
        <TriggersPage
          ctx={pageCtx(c, auth.user)}
          shell={shell}
          view={{
            triggers,
            events: events.map((e) => eventView(c, e, names)),
            accounts,
            keys: keys.map((k) => ({ id: k.id, label: `${k.label} (${k.model})` })),
            hasTelegram: channels.telegram.linked,
            flash: takeFlash(c),
          }}
        />,
      );
    }),
  );

  app.post(
    '/app/triggers',
    appAction('/app/triggers', async (c, auth, form) => {
      let input: ReturnType<typeof triggerInput>;
      try {
        input = triggerInput(form);
      } catch (error) {
        if (error instanceof BadArgs) {
          setFlash(c, 'bad', 'triggers.flash.badArgs');
          return undefined;
        }
        throw error;
      }
      await c.get('services').triggers.service.create(sessionPrincipal(auth), input);
      setFlash(c, 'ok', 'triggers.flash.created');
      return undefined;
    }),
  );

  app.post(
    '/app/triggers/:id/toggle',
    appAction('/app/triggers', async (c, auth, form) => {
      await c.get('services').triggers.service.update(sessionPrincipal(auth), c.req.param('id')!, {
        enabled: form.enabled === '1',
      });
      setFlash(c, 'ok', 'triggers.flash.saved');
      return undefined;
    }),
  );

  app.post(
    '/app/triggers/:id/delete',
    appAction('/app/triggers', async (c, auth) => {
      await c.get('services').triggers.service.delete(auth.workspace.id, c.req.param('id')!);
      setFlash(c, 'ok', 'triggers.flash.deleted');
      return undefined;
    }),
  );

  app.get(
    '/app/ai',
    appPage('/app/ai', async (c, auth) => {
      const s = c.get('services');
      const ws = auth.workspace.id;
      const [keys, triggers, shell] = await Promise.all([
        s.triggers.keys.list(ws),
        s.triggers.service.list(ws),
        shellInfo(c, ws),
      ]);
      return c.html(
        <AiKeysPage
          ctx={pageCtx(c, auth.user)}
          shell={shell}
          view={{
            keys,
            providers: AI_PROVIDER_IDS.map((id) => {
              const p = AI_PROVIDERS[id];
              return { id, name: p.name, defaultModel: p.defaultModel, keysUrl: p.keysUrl };
            }),
            aiTriggers: triggers.filter((tr) => tr.do === 'ai').length,
            defaultRuns: DEFAULT_DAILY_RUNS,
            flash: takeFlash(c),
          }}
        />,
      );
    }),
  );

  const KeyForm = z.object({
    provider: z.enum(AI_PROVIDER_IDS),
    key: z.string().trim().min(1).max(500),
    label: z.string().trim().max(60).default(''),
    model: z.string().trim().max(100).default(''),
  });

  app.post(
    '/app/ai',
    appAction('/app/ai', async (c, auth, form) => {
      const input = KeyForm.parse(form);
      await c.get('services').triggers.keys.create(auth.workspace.id, {
        provider: input.provider,
        key: input.key,
        label: input.label || undefined,
        model: input.model || undefined,
        // The page asks only for the key: the limit starts at the default, and the AI changes it.
        dailyRuns:
          'dailyRuns' in form || 'noLimit' in form ? dailyLimit(form, 'dailyRuns') : DEFAULT_DAILY_RUNS,
      });
      setFlash(c, 'ok', 'aikeys.flash.saved');
      return undefined;
    }),
  );

  app.post(
    '/app/ai/:id',
    appAction('/app/ai', async (c, auth, form) => {
      const model = z.string().trim().max(100).default('').parse(form.model);
      await c.get('services').triggers.keys.update(auth.workspace.id, c.req.param('id')!, {
        ...(model ? { model } : {}),
        dailyRuns: dailyLimit(form, 'dailyRuns'),
      });
      setFlash(c, 'ok', 'aikeys.flash.updated');
      return undefined;
    }),
  );

  app.post(
    '/app/ai/:id/delete',
    appAction('/app/ai', async (c, auth) => {
      await c.get('services').triggers.keys.delete(auth.workspace.id, c.req.param('id')!);
      setFlash(c, 'ok', 'aikeys.flash.deleted');
      return undefined;
    }),
  );

  return app;
}
