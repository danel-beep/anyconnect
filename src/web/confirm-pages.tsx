import type { FC } from 'hono/jsx';
import type { PendingCallStatus, RiskLevel } from '../db/schema.js';
import type { Translate } from './i18n.js';
import { Layout } from './pages.js';

export interface PendingCallView {
  id: string;
  status: PendingCallStatus;
  client: string;
  service: string;
  account: string;
  action: string;
  risk: RiskLevel;
  reason?: string | undefined;
  arguments: string;
  createdAt: Date;
  expiresAt: Date;
  executeAt: Date | null;
}

const fmt = (date: Date) => date.toISOString().replace('T', ' ').slice(0, 19);

const CallDetails: FC<{ t: Translate; call: PendingCallView }> = ({ t, call }) => (
  <>
    <p>
      <span class={`badge ${call.risk === 'dangerous' ? 'bad' : ''}`}>{t(`risk.${call.risk}` as const)}</span>{' '}
      <strong>{t(`confirm.status.${call.status}` as const)}</strong>
    </p>
    <table>
      <tbody>
        <tr>
          <th>{t('confirm.client')}</th>
          <td>{call.client}</td>
        </tr>
        <tr>
          <th>{t('confirm.service')}</th>
          <td>
            {call.service} · {call.account}
          </td>
        </tr>
        <tr>
          <th>{t('confirm.action')}</th>
          <td>{call.action}</td>
        </tr>
        {call.reason ? (
          <tr>
            <th>{t('confirm.reason')}</th>
            <td>{call.reason}</td>
          </tr>
        ) : null}
        {call.status === 'awaiting_confirmation' ? (
          <tr>
            <th>{t('confirm.expires')}</th>
            <td>{fmt(call.expiresAt)} UTC</td>
          </tr>
        ) : null}
        {call.status === 'scheduled' && call.executeAt ? (
          <tr>
            <th>{t('confirm.runsAt')}</th>
            <td>{fmt(call.executeAt)} UTC</td>
          </tr>
        ) : null}
      </tbody>
    </table>
    <p class="small muted">{t('confirm.arguments')}:</p>
    <pre class="args">{call.arguments}</pre>
  </>
);

const Decision: FC<{ t: Translate; call: PendingCallView; csrf: string }> = ({ t, call, csrf }) =>
  call.status === 'awaiting_confirmation' ? (
    <form method="post" action={`/confirm/${call.id}`}>
      <input type="hidden" name="csrf" value={csrf} />
      <div class="actions">
        <button type="submit" name="decision" value="deny">
          {t('confirm.deny')}
        </button>
        <button class="primary" type="submit" name="decision" value="approve">
          {t('confirm.approve')}
        </button>
      </div>
    </form>
  ) : call.status === 'scheduled' ? (
    <form method="post" action={`/confirm/${call.id}`}>
      <input type="hidden" name="csrf" value={csrf} />
      <div class="actions">
        <button class="danger" type="submit" name="decision" value="cancel">
          {t('confirm.cancel')}
        </button>
      </div>
    </form>
  ) : null;

export const ConfirmPage: FC<{ t: Translate; lang: string; call: PendingCallView; csrf: string }> = ({
  t,
  lang,
  call,
  csrf,
}) => (
  <Layout title={t('confirm.title')} narrow lang={lang}>
    <div class="card">
      <h1>{t('confirm.title')}</h1>
      <CallDetails t={t} call={call} />
      <Decision t={t} call={call} csrf={csrf} />
      <p class="small">
        <a href="/confirm">{t('confirm.listTitle')}</a>
      </p>
    </div>
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
}> = ({ t, lang, calls, telegram, csrf }) => (
  <Layout title={t('confirm.listTitle')} lang={lang}>
    <header class="top">
      <a class="brand" href="/">
        AnyConnect
      </a>
    </header>
    <div class="card">
      <h1>{t('confirm.listTitle')}</h1>
      {calls.length === 0 ? <p class="muted">{t('confirm.none')}</p> : null}
      {calls.map((call) => (
        <div class="item">
          <CallDetails t={t} call={call} />
          <Decision t={t} call={call} csrf={csrf} />
        </div>
      ))}
    </div>
    <div class="card">
      <h2>{t('home.telegram')}</h2>
      {!telegram.enabled ? (
        <p class="muted">{t('home.telegramDisabled')}</p>
      ) : telegram.linked ? (
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
  </Layout>
);
