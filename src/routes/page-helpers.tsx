import type { Child } from 'hono/jsx';
import { z } from 'zod';
import { getDefaultWorkspace } from '../core/identity.js';
import { type AppSection, AppShell, type ShellInfo } from '../web/app.js';
import { type Frame, PageFrame } from '../web/frame.js';
import { clearCookie, csrfToken, readCookie, setSecureCookie, verifyCsrf } from '../web/http.js';
import type { Key, Locale } from '../web/i18n.js';
import type { PageCtx } from '../web/page-context.js';
import { ErrorPage } from '../web/pages.js';
import type { SessionUser, WebSession } from '../web/sessions.js';
import { type AppContext, currentSession, loginUrl, secondFactorRedirect } from './context.js';

/** Remembers the chosen interface language (set by the RU/EN switch and the profile form). */
export const LANG_COOKIE = 'ac_lang';
const FLASH_COOKIE = 'ac_flash';

export const cookieOpts = (c: AppContext) => ({ secure: c.get('services').config.secureCookies });

/** The language picked by the switch, if any (it wins over Accept-Language). */
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
    billing: s.billing !== undefined,
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

/** Sidebar data: the plan name and how many calls wait for a confirmation. */
export async function shellInfo(c: AppContext, workspaceId: string): Promise<ShellInfo> {
  const s = c.get('services');
  const [subscription, open] = await Promise.all([
    s.entitlements.subscription(workspaceId),
    s.pendingCalls.listOpen(workspaceId),
  ]);
  return {
    planId: s.entitlements.planFor(subscription).id,
    pendingConfirmations: open.filter((row) => row.status === 'awaiting_confirmation').length,
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
