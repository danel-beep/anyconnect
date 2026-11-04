import type { Plan } from '../../billing/plans.js';
import { BRAND } from '../../brand.js';

/**
 * schema.org data for search engines and AI answer engines (JSON-LD). Plain builders: pages pick
 * the ones that describe them and `Doc` serializes them into `<script type="application/ld+json">`.
 * Only facts that the page itself shows go in here (Google's rule, and the site honesty rule).
 */
export type JsonLd = Record<string, unknown>;

const CONTEXT = 'https://schema.org';

export function organization(publicUrl: string, supportEmail?: string): JsonLd {
  return {
    '@context': CONTEXT,
    '@type': 'Organization',
    '@id': `${publicUrl}/#organization`,
    name: BRAND.name,
    url: `${publicUrl}/`,
    logo: `${publicUrl}/favicon.svg`,
    ...(supportEmail
      ? {
          email: supportEmail,
          contactPoint: { '@type': 'ContactPoint', email: supportEmail, contactType: 'customer support' },
        }
      : {}),
  };
}

export function website(publicUrl: string, description: string, lang: string): JsonLd {
  return {
    '@context': CONTEXT,
    '@type': 'WebSite',
    '@id': `${publicUrl}/#website`,
    name: BRAND.name,
    url: `${publicUrl}/`,
    description,
    inLanguage: lang,
    publisher: { '@id': `${publicUrl}/#organization` },
  };
}

/** The product with its public plans as offers (prices in USD per month). */
export function softwareApplication(
  publicUrl: string,
  opts: { description: string; plans: readonly Plan[]; planName: (plan: Plan) => string },
): JsonLd {
  const plans = opts.plans.filter((p) => p.public);
  return {
    '@context': CONTEXT,
    '@type': 'SoftwareApplication',
    '@id': `${publicUrl}/#app`,
    name: BRAND.name,
    url: `${publicUrl}/`,
    description: opts.description,
    applicationCategory: 'BusinessApplication',
    applicationSubCategory: 'MCP server',
    operatingSystem: 'Web',
    publisher: { '@id': `${publicUrl}/#organization` },
    offers: plans.map((plan) => ({
      '@type': 'Offer',
      name: opts.planName(plan),
      price: String(plan.priceMonthly),
      priceCurrency: 'USD',
      url: `${publicUrl}/pricing`,
      ...(plan.priceMonthly > 0
        ? {
            priceSpecification: {
              '@type': 'UnitPriceSpecification',
              price: String(plan.priceMonthly),
              priceCurrency: 'USD',
              billingDuration: 'P1M',
            },
          }
        : {}),
    })),
  };
}

/** Breadcrumbs from the home page to the current page (the last item is the page itself). */
export function breadcrumbs(publicUrl: string, items: { name: string; path: string }[]): JsonLd {
  return {
    '@context': CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: `${publicUrl}${item.path}`,
    })),
  };
}

export function faqPage(items: { q: string; a: string }[]): JsonLd {
  return {
    '@context': CONTEXT,
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
}

/** Step-by-step instructions (client guides, "connect X to Y" pages). */
export function howTo(opts: {
  name: string;
  description: string;
  url: string;
  steps: { name: string; text: string }[];
  /** ISO 8601 duration, e.g. PT3M. */
  totalTime?: string;
  lang: string;
}): JsonLd {
  return {
    '@context': CONTEXT,
    '@type': 'HowTo',
    name: opts.name,
    description: opts.description,
    url: opts.url,
    inLanguage: opts.lang,
    ...(opts.totalTime ? { totalTime: opts.totalTime } : {}),
    tool: [{ '@type': 'HowToTool', name: BRAND.name }],
    step: opts.steps.map((s, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: s.name,
      text: s.text,
      url: `${opts.url}#step-${i + 1}`,
    })),
  };
}

/** An explanatory page (articles, comparisons). `updated` is an ISO date. */
export function article(opts: {
  publicUrl: string;
  headline: string;
  description: string;
  url: string;
  updated: string;
  lang: string;
}): JsonLd {
  return {
    '@context': CONTEXT,
    '@type': 'TechArticle',
    headline: opts.headline,
    description: opts.description,
    url: opts.url,
    inLanguage: opts.lang,
    dateModified: opts.updated,
    author: { '@id': `${opts.publicUrl}/#organization` },
    publisher: { '@id': `${opts.publicUrl}/#organization` },
    about: { '@id': `${opts.publicUrl}/#app` },
  };
}

/**
 * JSON for an inline `<script type="application/ld+json">`: `<`, `>` and `&` are escaped so text
 * from the catalogue can never close the script element, and so are the JS line separators.
 */
export function serializeJsonLd(data: JsonLd | JsonLd[]): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
