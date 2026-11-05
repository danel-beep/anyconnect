import type { FC } from 'hono/jsx';
import type { PendingCallStatus, RiskLevel } from '../db/schema.js';
import { PageHead } from './app.js';
import { serviceMeta } from './catalog.js';
import type { Translate } from './i18n.js';
import { Layout } from './pages.js';
import { RiskBadge } from './setup-guide.js';
import { fmtAgo, fmtDate, Icon, ServiceLogo } from './ui.js';

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
          {heading === 1 ? <h1 class="h2">{call.action}</h1> : <h2 class="h3">{call.action}</h2>}
          <p class="small muted">
            {call.service} · {call.account}
          </p>
        </div>
        <RiskBadge t={t} risk={call.risk} />
      </div>
      <p class="pending-meta small">
        <strong>{t(`confirm.status.${call.status}` as const)}</strong>
        <span class="muted">
          {' · '}
          {t('confirm.page.asked', { client: call.client })} <When lang={lang} date={call.createdAt} />
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
        <details class="pending-args" open={open}>
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
    {calls.length === 0 ? (
      <div class="card empty-state">
        <span class="empty-icon" aria-hidden="true">
          <Icon name="check" />
        </span>
        <h2 class="h3">{t('confirm.page.noneTitle')}</h2>
        <p class="muted">{t('confirm.page.noneText')}</p>
        <p class="small">
          {t('confirm.page.now', { rule })} <a href="/app/rules">{t('confirm.page.change')}</a>
        </p>
      </div>
    ) : (
      <div class="stack">
        {calls.map((call) => (
          <PendingCall t={t} lang={lang} call={call} csrf={csrf} heading={2} />
        ))}
      </div>
    )}
    {telegram.enabled ? (
      <div class="card" id="telegram">
        <h2 class="h3">{t('home.telegram')}</h2>
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
