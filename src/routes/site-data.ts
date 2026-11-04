import { actionRisk, actionText, connectorGuide, connectorText } from '../connectors/sdk.js';
import { HIDDEN_SERVICES, serviceAlternative } from '../web/catalog.js';
import type { Locale } from '../web/i18n.js';
import type { PublicService, ServiceDetail } from '../web/site.js';
import type { AppContext } from './context.js';

/**
 * What the public pages know about the catalogue: built-in services as visitors see them (the setup
 * and demo connectors are hidden), and one service in full (setup guide, prompts, actions). The
 * website, the docs and search pages, the sitemap and llms.txt all read it from here.
 */
export async function publicServices(
  c: AppContext,
  lang: Locale = c.get('locale'),
): Promise<PublicService[]> {
  const s = c.get('services');
  const entries = await s.admin.services(undefined);
  const builtin = new Map(s.connectors.builtin.all().map((x) => [x.id, x]));
  return entries
    .filter((e) => !HIDDEN_SERVICES.has(e.service))
    .map((e) => ({
      id: e.service,
      // Names in the page language ("Почта (IMAP/SMTP)"), as the connect form shows them.
      name: builtin.has(e.service) ? connectorText(builtin.get(e.service)!, lang).name : e.name,
      description: e.description,
      connect: e.connect,
      ready: e.ready,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One public service with its setup guide, example requests and actions in a language. */
export async function serviceDetail(
  c: AppContext,
  id: string,
  lang: Locale = c.get('locale'),
): Promise<ServiceDetail | undefined> {
  if (HIDDEN_SERVICES.has(id)) return undefined;
  return (await serviceDetails(c, lang, [id]))[0];
}

/** Every public service in full (or only `ids`), in catalogue order. */
export async function serviceDetails(
  c: AppContext,
  lang: Locale = c.get('locale'),
  ids?: string[],
): Promise<ServiceDetail[]> {
  const connectors = c.get('services').connectors.builtin.all();
  const byId = new Map(connectors.map((x) => [x.id, x]));
  const entries = (await publicServices(c, lang)).filter((e) => !ids || ids.includes(e.id));
  return entries.flatMap((entry) => {
    const connector = byId.get(entry.id);
    if (!connector) return [];
    const guide = connectorGuide(connector, lang, entry.connect === 'oauth' ? 'oauth' : 'form');
    return [
      {
        ...entry,
        guide: guide.setup,
        prompts: guide.prompts,
        alternative: entry.ready ? undefined : serviceAlternative(entry.id, connectors, lang),
        // Texts for people in the page language; the AI keeps the connector's own descriptions.
        actions: connector.actions.map((a) => ({
          name: a.name,
          ...actionText(connector, a, lang),
          risk: actionRisk(a),
        })),
      },
    ];
  });
}
