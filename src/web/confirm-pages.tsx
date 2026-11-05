import type { FC } from 'hono/jsx';
import type { PendingCallStatus, RiskLevel } from '../db/schema.js';
import { PageHead } from './app.js';
import { serviceMeta } from './catalog.js';
import type { Translate } from './i18n.js';
import { Layout } from './pages.js';
import { RiskBadge } from './setup-guide.js';
import { AskAi, fmtAgo, fmtDate, Icon, ServiceLogo } from './ui.js';

/**
 * Actions the hub holds back for the owner's OK (`/confirm`, `/confirm/<id>`): what the AI wants
 * to do, with which account and what exactly it passed, with Allow / Deny right there.
 */
export interface PendingCallView {
  id: string;
  status: PendingCallStatus;
  client: string;
  connectorId: string;
  service: string;
  account: string;
  action: string;
  risk: RiskLevel;
  reason?: string | undefined;
  /** What the AI passed, as name and value pairs (see `argumentFields`). */
  fields: { name: string; value: string }[];
  createdAt: Date;
  expiresAt: Date;
  executeAt: Date | null;
}

/** "subjectLine" / "subject_line" → "Subject line". */
const fieldLabel = (name: string) => {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const When: FC<{ lang: string; date: Date }> = ({ lang, date }) => (
  <time datetime={date.toISOString()} title={`${fmtDate(lang, date, true)} UTC`}>
    {fmtAgo(lang, date)}
  </time>
);

const Decision: FC<{ t: Translate; call: PendingCallView; csrf: string }> = ({ t, call, csrf }) =>
  call.status === 'awaiting_confirmation' ? (
    <form method="post" action={`/confirm/${call.id}`} class="actions start pending-actions">
      <input type="hidden" name="csrf" value={csrf} />
      <button class="primary" type="submit" name="decision" value="approve">
        <Icon name="check" /> {t('confirm.page.allow')}
      </button>
      <button type="submit" name="decision" value="deny">
        {t('confirm.page.deny')}
      </button>
    </form>
  ) : call.status === 'scheduled' ? (
    <form method="post" action={`/confirm/${call.id}`} class="actions start pending-actions">
      <input type="hidden" name="csrf" value={csrf} />
      <button class="danger" type="submit" name="decision" value="cancel">
        {t('confirm.page.cancel')}
      </button>
    </form>
  ) : null;

/** One held-back action: what, where, who asked, until when, the details and the decision. */
const PendingCall: FC<{
  t: Translate;
  lang: string;
  call: PendingCallView;
  csrf: string;
  heading: 1 | 2;
}> = ({ t, lang, call, csrf, heading }) => {
  const meta = serviceMeta(call.connectorId);
  const open = call.status === 'awaiting_confirmation' || call.status === 'scheduled';
  return (
    <article class={`card pending-call${open ? ' open' : ''}`} id={`call-${call.id}`}>
      <div class="pending-head">
        <ServiceLogo icon={meta?.icon} glyph={meta?.glyph} name={call.service} />
        <div class="grow">
          <p class="small muted pending-who">{t('confirm.page.wants', { client: call.client })}</p>
          {heading === 1 ? <h1>{call.action}</h1> : <h2>{call.action}</h2>}
          <p class="small muted">
            {call.service} · {call.account}
          </p>
        </div>
        <RiskBadge t={t} risk={call.risk} />
      </div>
      <p class="pending-meta small">
        {/* "Waiting for your confirmation" is said by the count above the list: only other states here. */}
        {call.status === 'awaiting_confirmation' ? null : (
          <strong>{t(`confirm.status.${call.status}` as const)} · </strong>
        )}
        <span class="muted">
          {t('confirm.page.askedAt')} <When lang={lang} date={call.createdAt} />
          {call.status === 'awaiting_confirmation' ? (
            <>
              {' · '}
              {t('confirm.page.expires')} <When lang={lang} date={call.expiresAt} />
            </>
          ) : null}
          {call.status === 'scheduled' && call.executeAt ? (
            <>
              {' · '}
              {t('confirm.page.runs')} <When lang={lang} date={call.executeAt} />
            </>
          ) : null}
        </span>
      </p>
      {call.reason ? (
        <p class="small">
          <span class="muted">{t('confirm.reason')}:</span> {call.reason}
        </p>
      ) : null}
      {call.fields.length ? (
        <details class="pending-args" id={`args-${call.id}`} open={open}>
          <summary>{t('confirm.page.details')}</summary>
          <dl class="arg-list">
            {call.fields.map((f) => (
              <div>
                <dt>{fieldLabel(f.name)}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      <Decision t={t} call={call} csrf={csrf} />
      {call.status === 'awaiting_confirmation' ? <p class="hint">{t('confirm.page.afterAllow')}</p> : null}
    </article>
  );
};

export const ConfirmPage: FC<{ t: Translate; lang: string; call: PendingCallView; csrf: string }> = ({
  t,
  lang,
  call,
  csrf,
}) => (
  <Layout title={t('confirm.title')} lang={lang}>
    <p class="crumbs">
      <a href="/confirm">{t('app.nav.confirm')}</a>
    </p>
    <PendingCall t={t} lang={lang} call={call} csrf={csrf} heading={1} />
    <p class="small">
      <a href="/confirm">{t('confirm.page.back')}</a>
    </p>
  </Layout>
);

export interface TelegramView {
  enabled: boolean;
  linked: boolean;
  label: string | null;
  /** Deep link right after the user asked to link. */
  linkUrl?: string;
}

export const ConfirmListPage: FC<{
  t: Translate;
  lang: string;
  calls: PendingCallView[];
  telegram: TelegramView;
  csrf: string;
  /** The workspace's "when to ask" setting, in words (e.g. "Only for risky actions"). */
  rule: string;
}> = ({ t, lang, calls, telegram, csrf, rule }) => (
  <Layout title={t('app.nav.confirm')} lang={lang}>
    <PageHead
      title={t('app.nav.confirm')}
      sub={t('confirm.page.sub')}
      actions={
        <a class="btn" href="/app/rules">
          <Icon name="shield" /> {t('confirm.page.rules')}
        </a>
      }
    />
    {/* Updates on its own: a new request shows up while the page is open. */}
    <div id="pending-live" data-poll="5">
      {calls.length === 0 ? (
        <div class="card empty-state">
          <span class="empty-icon" aria-hidden="true">
            <Icon name="check" />
          </span>
          <h2>{t('confirm.page.noneTitle')}</h2>
          <p class="muted">{t('confirm.page.noneText')}</p>
          <p class="small">
            {t('confirm.page.now', { rule })} <a href="/app/rules">{t('confirm.page.change')}</a>
          </p>
        </div>
      ) : (
        <div class="stack">
          <p class="pending-count" role="status">
            {t('confirm.page.waiting', {
              n: calls.filter((c) => c.status === 'awaiting_confirmation').length,
            })}
          </p>
          {calls.map((call) => (
            <PendingCall t={t} lang={lang} call={call} csrf={csrf} heading={2} />
          ))}
        </div>
      )}
    </div>
    <div class="card">
      <h2>{t('confirm.how.title')}</h2>
      <ol class="how-steps">
        {(['ask', 'see', 'decide'] as const).map((step, i) => (
          <li>
            <span class="how-num" aria-hidden="true">
              {i + 1}
            </span>
            <span>
              <strong>{t(`confirm.how.${step}`)}</strong>
              <span class="small muted">{t(`confirm.how.${step}Text`)}</span>
            </span>
          </li>
        ))}
      </ol>
      <AskAi
        t={t}
        id="confirm-try"
        title={t('confirm.try.title')}
        text={t('confirm.try.text')}
        prompts={[t('confirm.try.rules'), t('confirm.try.stricter')]}
      />
    </div>
    {telegram.enabled ? (
      <div class="card" id="telegram">
        <div class="tg-head">
          <span class="ask-ai-icon" aria-hidden="true">
            <Icon name="bell" />
          </span>
          <div>
            <h2>{t('home.telegram')}</h2>
            <p class="small muted">{t('confirm.tg.why')}</p>
          </div>
        </div>
        {telegram.linked ? (
          <form method="post" action="/telegram/unlink">
            <input type="hidden" name="csrf" value={csrf} />
            <p>
              {t('home.telegramLinked', { label: telegram.label ?? 'Telegram' })}{' '}
              <button class="link" type="submit">
                {t('home.telegramUnlink')}
              </button>
            </p>
          </form>
        ) : (
          <>
            <p class="muted">{t('home.telegramNotLinked')}</p>
            {telegram.linkUrl ? (
              <p>
                {t('home.telegramOpen')}{' '}
                <a href={telegram.linkUrl} rel="noreferrer">
                  {telegram.linkUrl}
                </a>
              </p>
            ) : (
              <form method="post" action="/telegram/link">
                <input type="hidden" name="csrf" value={csrf} />
                <button class="primary" type="submit">
                  {t('home.telegramLink')}
                </button>
              </form>
            )}
          </>
        )}
      </div>
    ) : null}
  </Layout>
);
