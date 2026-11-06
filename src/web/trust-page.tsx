import type { FC } from 'hono/jsx';
import { BRAND } from '../brand.js';
import type { PageCtx } from './page-context.js';
import { localizedPath } from './seo/urls.js';
import { GuideText } from './setup-guide.js';
import { SiteLayout } from './site.js';
import type { Protection, TrustDoc } from './trust.js';
import { Icon } from './ui.js';

/** Badge colour per protection level: green when nobody but you (or nobody at all) can read it. */
const BADGE: Record<Protection, string> = {
  sealed: 'badge ok',
  hash: 'badge ok',
  transit: 'badge ok',
  server: 'badge warn',
  plain: 'badge',
};

/** `/trust`: what is encrypted, who sees what and how to delete data (texts in `trust.ts`). */
export const TrustPage: FC<{ ctx: PageCtx; doc: TrustDoc }> = ({ ctx, doc }) => {
  const { encrypted: enc, who, remove, limits, more } = doc;
  return (
    <SiteLayout
      ctx={ctx}
      title={`${doc.title} · ${BRAND.name}`}
      description={doc.description}
      current="security"
      canonicalPath="/trust"
    >
      <div class="wrap trust">
        <div class="section-head trust-head">
          <h1>{doc.title}</h1>
          <p>{doc.lead}</p>
          <p class="muted small">{doc.updated}</p>
        </div>

        <div class="trust-glance">
          {doc.glance.map((g) => (
            <div class="card">
              <span class="trust-icon">
                <Icon name={g.icon} />
              </span>
              <h2>{g.title}</h2>
              <p class="muted">{g.text}</p>
            </div>
          ))}
        </div>

        <section class="trust-section" id="encryption">
          <h2>{enc.title}</h2>
          <p class="muted">{enc.intro}</p>
          <div class="card flush">
            <table class="trust-table">
              <thead>
                <tr>
                  {enc.columns.map((c) => (
                    <th>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {enc.rows.map((r) => (
                  <tr>
                    <td>{r.data}</td>
                    <td data-label={enc.columns[1]}>
                      <span class={BADGE[r.protection]}>{enc.badges[r.protection]}</span>
                      <p>{r.how}</p>
                    </td>
                    <td data-label={enc.columns[2]}>{r.who}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section class="trust-section" id="who">
          <h2>{who.title}</h2>
          <p class="muted">{who.intro}</p>
          <div class="trust-parties">
            {who.parties.map((p) => (
              <div class="card">
                <h3>{p.name}</h3>
                <p class="trust-label">{who.seesLabel}</p>
                <ul class="trust-points">
                  {p.sees.map((x) => (
                    <li>
                      <Icon name="eye" />
                      <span>{x}</span>
                    </li>
                  ))}
                </ul>
                <p class="trust-label">{who.neverLabel}</p>
                <ul class="trust-points never">
                  {p.never.map((x) => (
                    <li>
                      <Icon name="x" />
                      <span>{x}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <section class="trust-section" id="delete">
          <h2>{remove.title}</h2>
          <p class="muted">{remove.intro}</p>
          <ol class="trust-steps">
            {remove.steps.map((s) => (
              <li class="card">
                <h3>{s.title}</h3>
                <p>
                  <GuideText text={s.text} />
                </p>
              </li>
            ))}
          </ol>
          <ul class="bullets">
            {remove.after.map((x) => (
              <li>{x}</li>
            ))}
          </ul>
        </section>

        <section class="trust-section" id="limits">
          <h2>{limits.title}</h2>
          <p class="muted">{limits.intro}</p>
          <ul class="bullets">
            {limits.items.map((x) => (
              <li>{x}</li>
            ))}
          </ul>
        </section>

        <section class="trust-section">
          <h2>{more.title}</h2>
          <ul class="bullets">
            {more.links.map((l) => (
              <li>
                <a href={localizedPath(l.href, ctx.lang)}>{l.label}</a>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </SiteLayout>
  );
};
