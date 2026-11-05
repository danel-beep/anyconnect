import type { Child } from 'hono/jsx';
import { z } from 'zod';
import { getDefaultWorkspace } from '../core/identity.js';
import { AppError } from '../lib/errors.js';
import { type AppSection, AppShell, type ShellInfo } from '../web/app.js';
import { type Frame, PageFrame } from '../web/frame.js';
import { clearCookie, csrfToken, readCookie, setSecureCookie, verifyCsrf } from '../web/http.js';
import type { Key, Locale } from '../web/i18n.js';
import type { PageCtx } from '../web/page-context.js';
import { ErrorPage } from '../web/pages.js';
import type { SessionUser, WebSession } from '../web/sessions.js';
import {
  type AppContext,
  bodyParams,
  currentSession,
  currentUser,
  loginUrl,
  secondFactorRedirect,
} from './context.js';

/** Remembers the chosen interface language (set by the RU/EN switch and the profile form). */
export const LANG_COOKIE = 'ac_lang';
const FLASH_COOKIE = 'ac_flash';

export const cookieOpts = (c: AppContext) => ({ secure: c.get('services').config.secureCookies });

/** The language picked by the switch or saved in settings, if any (otherwise `DEFAULT_LOCALE`). */
export function savedLocale(c: AppContext): Locale | undefined {
  const value = readCookie(c, LANG_COOKIE, cookieOpts(c));
  return value === 'ru' || value === 'en' ? value : undefined;
}

export function saveLocale(c: AppContext, locale: Locale | null): void {
  if (!locale) clearCookie(c, LANG_COOKIE, cookieOpts(c));
  else setSecureCookie(c, LANG_COOKIE, locale, { ...cookieOpts(c), maxAge: 60 * 60 * 24 * 365 });
}

/** What every page needs about the request (language, user, hub features, CSRF token). */
export function pageCtx(c: AppContext, user?: SessionUser): PageCtx {
  const s = c.get('services');
  const url = new URL(c.req.url);
  return {
    t: c.get('t'),
    lang: c.get('locale'),
    path: url.pathname + url.search,
    publicUrl: s.config.publicUrl,
    mcpUrl: s.config.mcpUrl,
    user: user ? { email: user.email, name: user.name, isAdmin: user.role === 'admin' } : undefined,
    google: s.externalLogin.get('google') !== undefined,
    signupsOpen: s.config.site.signups === 'open',
    supportEmail: s.config.site.supportEmail,
    billing: s.billing.enabled,
    csrf: csrfToken(c, cookieOpts(c)),
  };
}

export interface AppAuth {
  session: WebSession & { token: string };
  user: SessionUser;
  workspace: { id: string; name: string };
}

/**
 * The signed-in user with their workspace, or where the browser has to go first (sign-in,
 * second-factor setup or re-confirmation when the hub requires 2FA).
 */
export async function requireApp(c: AppContext, next: string): Promise<AppAuth | { redirect: string }> {
  const s = c.get('services');
  const session = await currentSession(c);
  if (!session) return { redirect: loginUrl(next) };
  const gate = await secondFactorRedirect(c, session, next);
  if (gate) return { redirect: gate };
  const workspace = await getDefaultWorkspace(s.db, session.user.id);
  if (!workspace) return { redirect: '/login' };
  return { session, user: session.user, workspace: { id: workspace.id, name: workspace.name } };
}

/** Sidebar data: the plan name, calls waiting for a confirmation and accounts that need a fix. */
export async function shellInfo(c: AppContext, workspaceId: string): Promise<ShellInfo> {
  const s = c.get('services');
  const user = await currentUser(c);
  const [subscription, open, accounts, planRequests] = await Promise.all([
    s.entitlements.subscription(workspaceId),
    // The user's own held-back actions, in teams too (what `/confirm` lists).
    user ? s.pendingCalls.listOpenFor(user.id) : s.pendingCalls.listOpen(workspaceId),
    s.accounts.list(workspaceId),
    user?.role === 'admin' ? s.entitlements.countOpenRequests() : undefined,
  ]);
  return {
    planId: s.entitlements.planFor(subscription).id,
    pendingConfirmations: open.filter((row) => row.status === 'awaiting_confirmation').length,
    brokenAccounts: accounts.filter((a) => a.enabled && a.status !== 'active').length,
    planRequests,
  };
}

/**
 * Renders a stand-alone page (security, confirmations) inside the dashboard layout. Works for any
 * signed-in user, including one who still has to set up the second factor.
 */
export async function renderInApp(
  c: AppContext,
  user: SessionUser,
  section: AppSection,
  page: Child,
  status: 200 | 400 | 403 | 429 = 200,
) {
  const workspace = await getDefaultWorkspace(c.get('services').db, user.id);
  if (!workspace) return c.html(<PageFrame.Provider value={null}>{page}</PageFrame.Provider>, status);
  const ctx = pageCtx(c, user);
  const shell = await shellInfo(c, workspace.id);
  const frame: Frame = ({ title, passkeys, children }) => (
    <AppShell ctx={ctx} shell={shell} section={section} title={title} passkeys={passkeys}>
      {children}
    </AppShell>
  );
  return c.html(<PageFrame.Provider value={frame}>{page}</PageFrame.Provider>, status);
}

// --- Flash messages ------------------------------------------------------------
// A one-time note shown after a form post and redirect ("Account renamed"). Only keys from the
// dictionary are accepted, and values are plain text (rendered escaped).

export type FlashKind = 'ok' | 'bad';
const FlashCookie = z.object({
  kind: z.enum(['ok', 'bad']),
  key: z.string().max(100),
  vars: z.record(z.string(), z.string().max(500)).optional(),
});

export function setFlash(c: AppContext, kind: FlashKind, key: Key, vars?: Record<string, string>): void {
  const value = Buffer.from(JSON.stringify({ kind, key, ...(vars ? { vars } : {}) })).toString('base64url');
  setSecureCookie(c, FLASH_COOKIE, value, { ...cookieOpts(c), maxAge: 120 });
}

export function takeFlash(c: AppContext): { kind: FlashKind; text: string } | undefined {
  const raw = readCookie(c, FLASH_COOKIE, cookieOpts(c));
  if (!raw) return undefined;
  clearCookie(c, FLASH_COOKIE, cookieOpts(c));
  try {
    const parsed = FlashCookie.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    const text = c.get('t')(parsed.key as Key, parsed.vars);
    return text === undefined ? undefined : { kind: parsed.kind, text };
  } catch {
    return undefined;
  }
}

// --- Forms ---------------------------------------------------------------------

export function csrfOk(c: AppContext, form: Record<string, string>): boolean {
  const s = c.get('services');
  return verifyCsrf(c, form.csrf, { ...cookieOpts(c), publicUrl: s.config.publicUrl });
}

export function csrfFailedPage(c: AppContext) {
  return c.html(<ErrorPage t={c.get('t')} lang={c.get('locale')} message={c.get('t')('error.csrf')} />, 403);
}

/** UI texts for error codes (`AppError.code`); other errors show their own (English) message. */
const ERROR_TEXTS: Partial<Record<string, Key>> = {
  not_found: 'error.code.not_found',
  self_change: 'error.code.self_change',
  admin_target: 'error.code.admin_target',
  confirm_email: 'error.code.confirm_email',
  no_workspace: 'error.code.no_workspace',
  unknown_plan: 'error.code.unknown_plan',
  unknown_limit: 'error.code.unknown_limit',
  bad_amount: 'error.code.bad_amount',
  past_date: 'error.code.past_date',
  amount_required: 'error.code.amount_required',
  plan_limit: 'error.code.plan_limit',
  payments_off: 'error.code.payments_off',
  plan_unavailable: 'error.code.plan_unavailable',
  special_plan: 'error.code.special_plan',
  same_plan: 'error.code.same_plan',
  other_provider: 'error.code.other_provider',
  no_subscription: 'error.code.no_subscription',
  provider_refused: 'error.code.provider_refused',
  provider_unavailable: 'error.code.provider_unavailable',
  paid_subscription: 'error.code.paid_subscription',
  csrf: 'error.csrf',
};

/** A user-facing text for an error from a form action, in the page language. */
export function uiError(c: AppContext, error: AppError | z.ZodError): string {
  const t = c.get('t');
  if (error instanceof z.ZodError) return t('app.flash.invalid');
  const key = ERROR_TEXTS[error.code];
  return key ? t(key) : error.message;
}

/** Error text for a failed form action: our own messages are user-safe, others are not shown. */
export const errorText = (c: AppContext, error: unknown): string =>
  error instanceof AppError ? uiError(c, error) : c.get('t')('error.internal');

/** Runs a GET page of the dashboard for the signed-in user. */
export const appPage =
  (path: string, render: (c: AppContext, auth: AppAuth) => Promise<Response>) => async (c: AppContext) => {
    const auth = await requireApp(c, new URL(c.req.url).pathname + new URL(c.req.url).search || path);
    if ('redirect' in auth) return c.redirect(auth.redirect, 302);
    return render(c, auth);
  };

/** Runs a dashboard form post: CSRF, session, then the action; errors come back as a flash note. */
export const appAction =
  (
    /** Where to go afterwards: a fixed page, or one picked from the posted form or the request. */
    to: string | ((form: Record<string, string>, c: AppContext) => string),
    run: (c: AppContext, auth: AppAuth, form: Record<string, string>) => Promise<Response | undefined>,
  ) =>
  async (c: AppContext) => {
    const form = await bodyParams(c);
    const back = typeof to === 'string' ? to : to(form, c);
    if (!csrfOk(c, form)) return csrfFailedPage(c);
    const auth = await requireApp(c, back);
    if ('redirect' in auth) return c.redirect(auth.redirect, 303);
    try {
      const response = await run(c, auth, form);
      if (response) return response;
    } catch (error) {
      if (error instanceof z.ZodError) {
        setFlash(c, 'bad', 'app.flash.invalid');
        return c.redirect(back, 303);
      }
      if (!(error instanceof AppError))
        c.get('services').logger.error({ err: error }, 'dashboard action failed');
      setFlash(c, 'bad', 'app.flash.error', { message: errorText(c, error).slice(0, 400) });
    }
    return c.redirect(back, 303);
  };
