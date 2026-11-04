import { escapeXml } from './crawlers.js';

/**
 * The blog's RSS 2.0 feed (`/blog/feed.xml`): feed readers, aggregators and some AI crawlers pick
 * up new posts from it. English, like the default site.
 */
export interface FeedItem {
  title: string;
  url: string;
  description: string;
  /** ISO date, e.g. 2026-11-04. */
  published: string;
}

const rfc822 = (iso: string) => new Date(`${iso}T00:00:00Z`).toUTCString();

export function rssFeed(opts: {
  title: string;
  link: string;
  selfUrl: string;
  description: string;
  items: FeedItem[];
}): string {
  const latest = opts.items
    .map((i) => i.published)
    .sort()
    .at(-1);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escapeXml(opts.title)}</title>`,
    `    <link>${escapeXml(opts.link)}</link>`,
    `    <atom:link href="${escapeXml(opts.selfUrl)}" rel="self" type="application/rss+xml"/>`,
    `    <description>${escapeXml(opts.description)}</description>`,
    '    <language>en</language>',
    ...(latest ? [`    <lastBuildDate>${rfc822(latest)}</lastBuildDate>`] : []),
    ...opts.items.map((i) =>
      [
        '    <item>',
        `      <title>${escapeXml(i.title)}</title>`,
        `      <link>${escapeXml(i.url)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(i.url)}</guid>`,
        `      <pubDate>${rfc822(i.published)}</pubDate>`,
        `      <description>${escapeXml(i.description)}</description>`,
        '    </item>',
      ].join('\n'),
    ),
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}
