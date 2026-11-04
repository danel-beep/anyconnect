import type { Plan } from '../../billing/plans.js';
import { BRAND } from '../../brand.js';
import type { ClientGuide } from '../clients.js';
import type { Translate } from '../i18n.js';
import type { PublicService, ServiceDetail } from '../site.js';
import type { Article } from './articles.js';
import type { ComparePage } from './compare-pages.js';
import { fill } from './facts.js';
import type { QA } from './types.js';

/**
 * `/llms.txt` and `/llms-full.txt` (https://llmstxt.org): what Manyplug is, in plain Markdown for
 * language models and AI answer engines. The short file is an index with one line per page; the
 * full one carries the guides, every service's tools and the FAQ, so an assistant that reads one
 * file can answer "how do I connect X to Y" correctly. English, like the default site.
 */
export interface LlmsInput {
  publicUrl: string;
  mcpUrl: string;
  /** English translator. */
  t: Translate;
  services: PublicService[];
  /** Full details, for llms-full.txt. */
  details?: ServiceDetail[];
  clients: { guide: ClientGuide; path: string; intro: string; name: string }[];
  plans: readonly Plan[];
  faq: QA[];
  articles: Article[];
  compare: ComparePage[];
  /** Placeholders of article and comparison texts (`{count}`, `{freeAccounts}`). */
  vars: Record<string, string | number>;
  serviceBlurb: (service: PublicService) => string;
  comboPath: (serviceId: string, guide: ClientGuide) => string;
}

const md = (s: string) => s.replace(/\s+/g, ' ').trim();

function summary(input: LlmsInput): string {
  const { t } = input;
  return md(t('faq.what.a'));
}

function planLines(input: LlmsInput): string[] {
  const { t } = input;
  return input.plans
    .filter((p) => p.public)
    .map((p) => {
      const name = t(`plan.${p.id}.name` as 'plan.free.name');
      const price = p.priceMonthly === 0 ? '$0' : `$${p.priceMonthly}/month or $${p.priceYearly}/year`;
      const actions = p.limits.actions === null ? 'unlimited actions' : `${p.limits.actions} actions/month`;
      const trial = p.start?.trial
        ? ` (new workspaces start with ${p.start.trial.days} days of ${t(`plan.${p.start.trial.plan}.name` as 'plan.free.name')} free)`
        : '';
      const accounts = p.limits.accounts === null ? 'unlimited accounts' : `${p.limits.accounts} accounts`;
      return `- ${name}: ${price}; ${actions}; ${accounts}${trial}.`;
    });
}

function facts(input: LlmsInput): string[] {
  const ready = input.services.filter((s) => s.ready);
  return [
    `- MCP server URL (same for every AI app): ${input.mcpUrl} — remote MCP over Streamable HTTP, sign-in with OAuth 2.1; a personal token works for clients without OAuth.`,
    `- Works with: ${input.clients
      .filter((c) => c.guide.id !== 'other')
      .map((c) => c.name)
      .join(', ')} and any other MCP client.`,
    `- Built-in services: ${ready.map((s) => s.name).join(', ')}. Any IMAP mailbox, any remote MCP server and any REST API can be added too.`,
    '- Several accounts per service, each with a name; read tools take account "all" to search every account at once.',
    '- Risky actions (sending, deleting, refunds) wait for the user’s approval by default; rules per account and per AI app; loosening a rule always needs the user’s OK.',
    '- Credentials are encrypted with a separate key per account and never shown to the AI; text from emails and web pages is marked as untrusted.',
    '- Setup works from the chat too: the AI returns a link to Manyplug’s own page for keys and sign-ins.',
  ];
}

export function llmsTxt(input: LlmsInput): string {
  const u = input.publicUrl;
  const ready = input.services.filter((s) => s.ready);
  return [
    `# ${BRAND.name}`,
    '',
    `> ${summary(input)}`,
    '',
    ...facts(input),
    '',
    '## Connect an AI app',
    '',
    `- [All AI apps](${u}/docs): one page with every client's steps.`,
    ...input.clients.map((c) => `- [${c.name}](${u}${c.path}): ${md(c.intro)}`),
    '',
    '## Services',
    '',
    `- [All services](${u}/services)`,
    ...ready.map((s) => `- [${s.name}](${u}/services/${s.id}): ${md(input.serviceBlurb(s))}`),
    '',
    '## Guides',
    '',
    ...input.articles.map(
      (a) => `- [${a.body.en.h1}](${u}/guides/${a.slug}): ${md(fill(a.body.en.description, input.vars))}`,
    ),
    `- [FAQ](${u}/faq)`,
    '',
    '## Comparisons',
    '',
    ...input.compare.map((p) => `- [${p.body.en.h1}](${u}/compare/${p.slug}): ${md(p.body.en.description)}`),
    '',
    '## Pricing',
    '',
    ...planLines(input),
    `- Details: ${u}/pricing`,
    '',
    '## Optional',
    '',
    `- [Full text for language models](${u}/llms-full.txt): guides, every service's tools and the FAQ in one file.`,
    `- [Privacy policy](${u}/privacy)`,
    `- [Terms of service](${u}/terms)`,
    '',
  ].join('\n');
}

const RISK_WORD = { read: 'reads', write: 'changes', dangerous: 'risky, asks first by default' } as const;

export function llmsFullTxt(input: LlmsInput): string {
  const u = input.publicUrl;
  const lines: string[] = [
    `# ${BRAND.name}: full reference`,
    '',
    `> ${summary(input)}`,
    '',
    `Website: ${u}. Short index: ${u}/llms.txt.`,
    '',
    '## Key facts',
    '',
    ...facts(input),
    '',
    '## Pricing',
    '',
    ...planLines(input),
    '- One action = one call of a service tool by the AI. Hub housekeeping (listing accounts, connecting one) is free.',
    '',
    '## Connect an AI app',
    '',
    'Sign up at the website with Google, connect services in the dashboard or by asking the AI, then add the MCP URL to the AI app:',
    '',
  ];
  for (const c of input.clients) {
    lines.push(`### ${c.name}`, '', md(c.intro), '');
    c.guide.steps.en.forEach((step, i) => {
      lines.push(`${i + 1}. ${step}`);
    });
    const code = c.guide.code?.(input.mcpUrl);
    if (code) lines.push('', '```', code, '```');
    lines.push('', `Guide: ${u}${c.path}`, '');
  }
  lines.push('## Services', '');
  for (const s of input.details ?? []) {
    if (!s.ready) continue;
    lines.push(`### ${s.name}`, '', md(input.serviceBlurb(s)), '');
    lines.push(
      s.connect === 'oauth'
        ? `Connect: sign in on ${s.name}'s own page (OAuth).`
        : s.connect === 'form'
          ? `Connect: paste an API key or app password into Manyplug's form.${s.guide?.summary ? ` ${md(s.guide.summary)}` : ''}`
          : 'Connect: nothing to configure.',
      '',
      'Tools:',
    );
    for (const a of s.actions) lines.push(`- ${a.title} (${RISK_WORD[a.risk]}): ${md(a.description)}`);
    if (s.prompts.length) {
      lines.push('', 'Example requests:');
      for (const p of s.prompts) lines.push(`- “${p}”`);
    }
    lines.push(
      '',
      `Page: ${u}/services/${s.id}. Per AI app: ${input.clients
        .filter((c) => c.guide.id !== 'other')
        .map((c) => `${u}${input.comboPath(s.id, c.guide)}`)
        .join(', ')}`,
      '',
    );
  }
  lines.push('## FAQ', '');
  for (const item of input.faq) lines.push(`### ${item.q}`, '', md(item.a), '');
  for (const a of input.articles) {
    const b = a.body.en;
    lines.push(`## ${b.h1}`, '', md(fill(b.answer, input.vars)), '');
    for (const s of b.sections) {
      lines.push(`### ${s.h}`, '');
      for (const p of s.p) lines.push(md(fill(p, input.vars)), '');
      if (s.list) lines.push(...s.list.map((x) => `- ${md(fill(x, input.vars))}`), '');
    }
    for (const q of b.faq) lines.push(`**${q.q}** ${md(q.a)}`, '');
  }
  for (const p of input.compare) {
    const b = p.body.en;
    lines.push(`## ${b.h1}`, '', md(fill(b.summary, input.vars)), '');
    for (const r of b.rows)
      lines.push(`- ${r.feature}: ${BRAND.name} — ${fill(r.manyplug, input.vars)}; ${p.other} — ${r.other}.`);
    lines.push('', `Choose ${BRAND.name} if:`, ...b.chooseManyplug.map((x) => `- ${x}`));
    lines.push('', `Choose ${p.other} if:`, ...b.chooseOther.map((x) => `- ${x}`));
    if (b.together) lines.push('', md(b.together));
    lines.push('', `Sources (checked ${p.checked}): ${p.sources.map((s) => s.url).join(', ')}`, '');
  }
  return lines.join('\n');
}
