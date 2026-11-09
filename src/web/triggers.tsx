import type { FC } from 'hono/jsx';
import type { AiProviderId, TriggerEventStatus } from '../db/schema.js';
import { AppShell, Flash, PageHead, type SetupStep, SetupSteps, type ShellInfo } from './app.js';
import type { Key } from './i18n.js';
import type { PageCtx } from './page-context.js';
import { AskAi, Fold, fmtAgo, fmtNumber, Hidden, Icon, Meter, SectionHead } from './ui.js';

/**
 * Triggers in the dashboard (`/app/triggers`): the rules "when a message or email matches, do…",
 * and the live feed of what they matched. The separate AI API page (`/app/ai`) holds the user's
 * own keys that `ai` triggers wake. The user's AI app sets both up through the chat tools
 * (`manyplug_*_trigger`, `manyplug_*ai_key*`), so the pages lead with what to ask it; pasting a key
 * is the only step that has to happen here. The manual form stays folded as a fallback. See
 * `docs/TRIGGERS.md`.
 */

export type TriggerKind = 'check' | 'notify' | 'tool' | 'ai';

export interface TriggerRowView {
  id: string;
  name: string;
  enabled: boolean;
  paused: string | null;
  when: 'message' | 'mail';
  accounts: string;
  everyAccount: boolean;
  filter: Record<string, string>;
  do: TriggerKind;
  action: string;
  dailyLimit: number | null;
  runsToday: number;
}

export interface TriggerEventView {
  id: string;
  trigger: string;
  status: TriggerEventStatus;
  service: string;
  from?: string | undefined;
  title?: string | undefined;
  preview?: string | undefined;
  summary?: string | undefined;
  /** Why it did not run (limit, loop…), or an error. */
  note?: string | undefined;
  tokens: number | null;
  at: Date;
}

export interface AccountOption {
  /** "", "service" or "service:name". */
  value: string;
  label: string;
  when: 'message' | 'mail';
}

export interface TriggersView {
  triggers: TriggerRowView[];
  events: TriggerEventView[];
  accounts: AccountOption[];
  keys: Array<{ id: string; label: string }>;
  hasTelegram: boolean;
  flash?: { kind: 'ok' | 'bad'; text: string } | undefined;
}

const STATUS_CLASS: Record<TriggerEventStatus, string> = {
  new: 'badge accent',
  delivered: 'badge ok',
  running: 'badge',
  done: 'badge ok',
  awaiting_confirmation: 'badge warn',
  failed: 'badge bad',
  skipped: 'badge',
};

const filterText = (ctx: PageCtx, filter: Record<string, string>): string => {
  const parts = Object.entries(filter).map(([k, v]) => `${ctx.t(`triggers.filter.${k}` as Key)}: ${v}`);
  return parts.length ? parts.join(' · ') : ctx.t('triggers.filter.any');
};

const TriggerList: FC<{ ctx: PageCtx; view: TriggersView }> = ({ ctx, view }) => {
  const { t, lang } = ctx;
  return (
    <div class="card flush">
      <div class="card-head pad">
        <h2>{t('triggers.list')}</h2>
      </div>
      <ul class="plain pad-x">
        {view.triggers.map((tr) => {
          const on = tr.enabled && !tr.paused;
          return (
            <li class="trigger-row">
              <span class="grow">
                <strong>{tr.name}</strong>{' '}
                {on ? (
                  <span class="badge ok">{t('triggers.on')}</span>
                ) : tr.paused ? (
                  <span class="badge warn">{t('triggers.paused')}</span>
                ) : (
                  <span class="badge">{t('triggers.off')}</span>
                )}
                <div class="small muted">
                  {t(`triggers.when.${tr.when}` as Key)} ·{' '}
                  {tr.everyAccount ? t('triggers.everyAccount') : tr.accounts} · {filterText(ctx, tr.filter)}
                </div>
                <div class="small">
                  <Icon name="arrow" /> {t(`triggers.do.${tr.do}` as Key)}
                  {tr.do === 'tool' || tr.do === 'ai' ? <code class="small">{tr.action}</code> : null}
                </div>
                <div class="small muted">
                  {tr.dailyLimit === null
                    ? t('triggers.runsNoLimit', { n: fmtNumber(lang, tr.runsToday) })
                    : t('triggers.runs', {
                        n: fmtNumber(lang, tr.runsToday),
                        max: fmtNumber(lang, tr.dailyLimit),
                      })}
                  {tr.paused ? ` · ${t('triggers.pausedWhy')}` : ''}
                </div>
              </span>
              <span class="trigger-actions">
                <form method="post" action={`/app/triggers/${encodeURIComponent(tr.id)}/toggle`}>
                  <Hidden values={{ csrf: ctx.csrf, enabled: on ? '0' : '1' }} />
                  <button type="submit" class="sm">
                    <Icon name={on ? 'pause' : 'play'} /> {t(on ? 'triggers.turnOff' : 'triggers.turnOn')}
                  </button>
                </form>
                <form method="post" action={`/app/triggers/${encodeURIComponent(tr.id)}/delete`}>
                  <Hidden values={{ csrf: ctx.csrf }} />
                  <button
                    type="submit"
                    class="sm danger"
                    aria-label={t('triggers.delete', { name: tr.name })}
                  >
                    <Icon name="trash" />
                  </button>
                </form>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const EventFeed: FC<{ ctx: PageCtx; view: TriggersView }> = ({ ctx, view }) => {
  const { t, lang } = ctx;
  return (
    <div class="card flush" id="trigger-events" data-poll="10">
      <div class="card-head pad">
        <h2>{t('triggers.events')}</h2>
        <p class="small muted">{t('triggers.eventsSub')}</p>
      </div>
      {view.events.length ? (
        <ul class="plain pad-x">
          {view.events.map((e) => (
            <li class="trigger-event">
              <span class="grow">
                <strong>{e.trigger}</strong>{' '}
                <span class={STATUS_CLASS[e.status]}>{t(`triggers.status.${e.status}` as Key)}</span>
                <div class="small muted">
                  {[e.service, e.from, e.title].filter(Boolean).join(' · ')}
                  {e.preview ? ` · ${e.preview}` : ''}
                </div>
                {e.summary ? <div class="small">{e.summary}</div> : null}
                {e.note ? <div class="small muted">{e.note}</div> : null}
              </span>
              <span class="small muted">
                {fmtAgo(lang, e.at)}
                {e.tokens ? ` · ${t('triggers.tokens', { n: fmtNumber(lang, e.tokens) })}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted pad">{t('triggers.noEvents')}</p>
      )}
    </div>
  );
};

const KINDS: TriggerKind[] = ['check', 'notify', 'tool', 'ai'];

const NewTrigger: FC<{ ctx: PageCtx; view: TriggersView }> = ({ ctx, view }) => {
  const { t } = ctx;
  return (
    <Fold id="new" icon="pen" title={t('triggers.manual')} sub={t('triggers.manualSub')}>
      <form method="post" action="/app/triggers" class="trigger-form">
        <Hidden values={{ csrf: ctx.csrf }} />
        <div class="grid-2 tight">
          <div>
            <label for="tr-name">{t('triggers.name')}</label>
            <input
              id="tr-name"
              type="text"
              name="name"
              required
              maxlength={80}
              placeholder={t('triggers.namePlaceholder')}
            />
          </div>
          <div>
            <label for="tr-account">{t('triggers.source')}</label>
            <select id="tr-account" name="account">
              <option value="message:">{t('triggers.allMessages')}</option>
              <option value="mail:">{t('triggers.allMail')}</option>
              {view.accounts.map((a) => (
                <option value={`${a.when}:${a.value}`}>{a.label}</option>
              ))}
            </select>
          </div>
        </div>
        <fieldset class="trigger-filter">
          <legend>{t('triggers.filter')}</legend>
          <p class="hint">{t('triggers.filterHint')}</p>
          <div class="grid-2 tight">
            {(['from', 'text', 'chat', 'subject'] as const).map((field) => (
              <div>
                <label for={`tr-${field}`}>{t(`triggers.filter.${field}` as Key)}</label>
                <input
                  id={`tr-${field}`}
                  type="text"
                  name={field}
                  maxlength={300}
                  placeholder={t(`triggers.filter.${field}Placeholder` as Key)}
                />
              </div>
            ))}
          </div>
        </fieldset>
        <fieldset class="choice-list">
          <legend>{t('triggers.action')}</legend>
          {KINDS.map((kind) => (
            <label class="choice">
              <input type="radio" name="do" value={kind} checked={kind === 'check'} />
              <span>
                <strong>{t(`triggers.do.${kind}` as Key)}</strong>
                <span class="small muted">{t(`triggers.do.${kind}Hint` as Key)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div class="trigger-more for-check">
          <label for="tr-task">{t('triggers.task')}</label>
          <input
            id="tr-task"
            type="text"
            name="task"
            maxlength={1000}
            placeholder={t('triggers.taskPlaceholder')}
          />
          <p class="hint">{t('triggers.taskHint')}</p>
        </div>
        <div class="trigger-more for-notify">
          <p class="hint">{view.hasTelegram ? t('triggers.notifyReady') : t('triggers.notifyNoTelegram')}</p>
        </div>
        <div class="trigger-more for-tool">
          <label for="tr-tool">{t('triggers.tool')}</label>
          <input
            id="tr-tool"
            type="text"
            name="tool"
            maxlength={100}
            placeholder="telegram_send"
            spellcheck={false}
          />
          <label for="tr-args">{t('triggers.args')}</label>
          <textarea
            id="tr-args"
            name="args"
            maxlength={4000}
            spellcheck={false}
            placeholder={'{"chat": "@me", "text": "{{from}}: {{text}}"}'}
          />
          <p class="hint">{t('triggers.argsHint')}</p>
        </div>
        <div class="trigger-more for-ai">
          {view.keys.length ? (
            <>
              <label for="tr-key">{t('triggers.key')}</label>
              <select id="tr-key" name="aiKey">
                {view.keys.map((k) => (
                  <option value={k.id}>{k.label}</option>
                ))}
              </select>
            </>
          ) : (
            <div class="notice">
              {t('triggers.noKey')}{' '}
              <a href="/app/ai">
                <strong>{t('triggers.addKey')}</strong>
              </a>
            </div>
          )}
          <label for="tr-instructions">{t('triggers.instructions')}</label>
          <textarea
            id="tr-instructions"
            name="instructions"
            maxlength={4000}
            placeholder={t('triggers.instructionsPlaceholder')}
          />
          <label for="tr-tools">{t('triggers.tools')}</label>
          <input
            id="tr-tools"
            type="text"
            name="tools"
            maxlength={1000}
            spellcheck={false}
            placeholder="telegram_read_chat, telegram_send"
          />
          <p class="hint">{t('triggers.toolsHint')}</p>
          <label class="check-label" for="tr-ask">
            <input id="tr-ask" type="checkbox" name="askBeforeRisky" checked /> {t('triggers.askBeforeRisky')}
          </label>
          <label class="check-label" for="tr-notify">
            <input id="tr-notify" type="checkbox" name="notify" checked /> {t('triggers.notifySummary')}
          </label>
        </div>
        <div class="grid-2 tight">
          <div>
            <label for="tr-limit">{t('triggers.limit')}</label>
            <input id="tr-limit" type="number" name="dailyLimit" min={1} max={100000} value="200" />
          </div>
          <label class="check-label trigger-nolimit" for="tr-nolimit">
            <input id="tr-nolimit" type="checkbox" name="noLimit" /> {t('triggers.noLimit')}
          </label>
        </div>
        <p class="hint">{t('triggers.limitHint')}</p>
        <div class="actions start">
          <button type="submit" class="primary">
            <Icon name="plus" /> {t('triggers.create')}
          </button>
        </div>
      </form>
    </Fold>
  );
};

export const TriggersPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: TriggersView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t } = ctx;
  return (
    <AppShell ctx={ctx} shell={shell} section="triggers" title={t('triggers.title')}>
      <PageHead title={t('triggers.title')} sub={t('triggers.sub')} />
      <Flash flash={view.flash} />
      <section class="card" id="ask">
        <SectionHead icon="chat" title={t('triggers.askTitle')} hint={t('triggers.askText')} />
        <AskAi
          t={t}
          id="triggers-ask"
          title={t('triggers.ask')}
          hint={t('triggers.askHint')}
          prompts={[
            t('triggers.askPrompt1'),
            t('triggers.askPrompt2'),
            t('triggers.askPrompt3'),
            t('triggers.askPrompt4'),
          ]}
        />
        <h3 class="trigger-kinds-title">{t('triggers.kinds')}</h3>
        <ul class="trigger-kinds">
          {KINDS.map((kind) => (
            <li>
              <strong>{t(`triggers.do.${kind}` as Key)}</strong>
              <span class="small muted">
                {t(`triggers.do.${kind}Hint` as Key)}
                {kind === 'ai' && !view.keys.length ? (
                  <>
                    {' '}
                    <a href="/app/ai">{t('triggers.kindAiNoKey')}</a>
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </section>
      {view.triggers.length ? <TriggerList ctx={ctx} view={view} /> : null}
      <EventFeed ctx={ctx} view={view} />
      <NewTrigger ctx={ctx} view={view} />
    </AppShell>
  );
};

// ---------------------------------------------------------------------------
// AI API keys
// ---------------------------------------------------------------------------

export interface AiKeyRowView {
  id: string;
  provider: AiProviderId;
  providerName: string;
  label: string;
  model: string;
  keyHint: string;
  dailyRuns: number | null;
  runsToday: number;
  tokensToday: number;
  lastUsedAt: Date | null;
  lastError: string | null;
}

export interface AiKeysView {
  keys: AiKeyRowView[];
  providers: Array<{ id: AiProviderId; name: string; defaultModel: string; keysUrl: string }>;
  /** Triggers that wake an AI on a key: the "tell your AI" step is done once there is one. */
  aiTriggers: number;
  defaultRuns: number;
  flash?: { kind: 'ok' | 'bad'; text: string } | undefined;
}

/** Pasting a key: the one step that cannot happen in a chat (keys never pass through one). */
const AddKeyForm: FC<{ ctx: PageCtx; view: AiKeysView }> = ({ ctx, view }) => {
  const { t, lang } = ctx;
  return (
    <form method="post" action="/app/ai" class="trigger-form" autocomplete="off">
      <Hidden values={{ csrf: ctx.csrf }} />
      <fieldset class="choice-list">
        <legend>{t('aikeys.provider')}</legend>
        {view.providers.map((p, i) => (
          <label class="choice">
            <input type="radio" name="provider" value={p.id} checked={i === 0} />
            <span>
              <strong>{p.name}</strong>
              <span class="small muted">{t('aikeys.defaultModel', { model: p.defaultModel })}</span>
              <span class="small">
                <a href={p.keysUrl} target="_blank" rel="noopener noreferrer">
                  {t('aikeys.getKey')}
                </a>
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <label for="k-key">{t('aikeys.key')}</label>
      <div class="key-paste">
        <input
          id="k-key"
          type="password"
          name="key"
          required
          maxlength={500}
          autocomplete="off"
          spellcheck={false}
          placeholder={t('aikeys.keyPlaceholder')}
        />
        <button type="submit" class="primary">
          <Icon name="check" /> {t('aikeys.saveKey')}
        </button>
      </div>
      <p class="hint">{t('aikeys.defaults', { n: fmtNumber(lang, view.defaultRuns) })}</p>
    </form>
  );
};

const KeyRow: FC<{ ctx: PageCtx; k: AiKeyRowView }> = ({ ctx, k }) => {
  const { t, lang } = ctx;
  const runs =
    k.dailyRuns === null
      ? t('aikeys.runsToday', { n: fmtNumber(lang, k.runsToday), tokens: fmtNumber(lang, k.tokensToday) })
      : t('aikeys.runsTodayOf', {
          n: fmtNumber(lang, k.runsToday),
          max: fmtNumber(lang, k.dailyRuns),
          tokens: fmtNumber(lang, k.tokensToday),
        });
  return (
    <li class="key-row">
      <div class="key-head">
        <span class="grow">
          <strong>{k.label}</strong> <span class="badge">{k.providerName}</span>
          <div class="small muted">
            <code class="small">{k.model}</code> · ••••{k.keyHint}
            {k.lastUsedAt ? ` · ${t('aikeys.lastUsed', { when: fmtAgo(lang, k.lastUsedAt) })}` : ''}
          </div>
          {k.lastError ? <div class="small key-error">{k.lastError}</div> : null}
        </span>
        <form method="post" action={`/app/ai/${encodeURIComponent(k.id)}/delete`}>
          <Hidden values={{ csrf: ctx.csrf }} />
          <button type="submit" class="sm danger" aria-label={t('aikeys.delete', { name: k.label })}>
            <Icon name="trash" />
          </button>
        </form>
      </div>
      <div class="small muted">{runs}</div>
      <Meter used={k.runsToday} limit={k.dailyRuns} label={runs} />
      <p class="small muted key-change">{t('aikeys.changeHint', { name: k.label })}</p>
      <details class="key-edit">
        <summary>{t('aikeys.editHere')}</summary>
        <form method="post" action={`/app/ai/${encodeURIComponent(k.id)}`} class="inline-form">
          <Hidden values={{ csrf: ctx.csrf }} />
          <div>
            <label for={`m-${k.id}`}>{t('aikeys.model')}</label>
            <input
              id={`m-${k.id}`}
              type="text"
              name="model"
              maxlength={100}
              value={k.model}
              spellcheck={false}
            />
          </div>
          <div>
            <label for={`l-${k.id}`}>{t('aikeys.limit')}</label>
            <input
              id={`l-${k.id}`}
              type="number"
              name="dailyRuns"
              min={1}
              max={100000}
              value={k.dailyRuns === null ? '' : String(k.dailyRuns)}
              placeholder={t('aikeys.noLimitShort')}
            />
          </div>
          <button type="submit" class="sm">
            {t('aikeys.save')}
          </button>
        </form>
        <p class="hint">{t('aikeys.limitHint')}</p>
      </details>
    </li>
  );
};

export const AiKeysPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: AiKeysView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t } = ctx;
  const hasKey = view.keys.length > 0;
  const steps: SetupStep[] = [
    {
      done: hasKey,
      title: t('aikeys.step1'),
      text: t('aikeys.step1Text'),
      cta: t('aikeys.step1Cta'),
      href: '#new',
    },
    {
      done: hasKey && view.aiTriggers > 0,
      title: t('aikeys.step2'),
      text: t('aikeys.step2Text'),
      cta: t('aikeys.step2Cta'),
      href: '#ask',
    },
    {
      done: view.keys.some((k) => k.lastUsedAt),
      title: t('aikeys.step3'),
      text: t('aikeys.step3Text'),
      cta: t('aikeys.step3Cta'),
      href: '/app/triggers',
    },
  ];
  return (
    <AppShell ctx={ctx} shell={shell} section="ai" title={t('aikeys.title')}>
      <PageHead title={t('aikeys.title')} sub={t('aikeys.sub')} />
      <Flash flash={view.flash} />
      <SetupSteps ctx={ctx} steps={steps} title={t('aikeys.steps')} />
      {hasKey ? null : (
        <section class="card" id="new">
          <SectionHead icon="key" title={t('aikeys.add')} hint={t('aikeys.addHint')} />
          <AddKeyForm ctx={ctx} view={view} />
        </section>
      )}
      <section class="card" id="ask">
        <SectionHead icon="chat" title={t('aikeys.askTitle')} hint={t('aikeys.askText')} />
        <AskAi
          t={t}
          id="aikeys-ask"
          title={t('aikeys.ask')}
          hint={t('aikeys.askHint')}
          prompts={[
            t('aikeys.askPrompt1'),
            t('aikeys.askPrompt2'),
            t('aikeys.askPrompt3'),
            t('aikeys.askPrompt4'),
          ]}
        />
      </section>
      {hasKey ? (
        <div class="card flush">
          <div class="card-head pad">
            <h2>{t('aikeys.list')}</h2>
          </div>
          <ul class="plain pad-x">
            {view.keys.map((k) => (
              <KeyRow ctx={ctx} k={k} />
            ))}
          </ul>
        </div>
      ) : null}
      {hasKey ? (
        <Fold id="new" icon="plus" title={t('aikeys.addAnother')} sub={t('aikeys.addAnotherSub')}>
          <AddKeyForm ctx={ctx} view={view} />
        </Fold>
      ) : null}
      <div class="card">
        <h2>{t('aikeys.safe')}</h2>
        <ul class="trigger-how">
          <li>{t('aikeys.safe1')}</li>
          <li>{t('aikeys.safe2')}</li>
          <li>{t('aikeys.safe3')}</li>
        </ul>
      </div>
    </AppShell>
  );
};
