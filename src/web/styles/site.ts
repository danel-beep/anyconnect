import { MONO } from '../assets.js';

/** The public website: header, hero, sections, service grid, pricing, footer. */
export const SITE_CSS = `
.wrap{width:100%;max-width:1180px;margin:0 auto;padding:0 24px}
@media (max-width:640px){.wrap{padding:0 16px}}

/* Header */
.site-header{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid transparent;transition:border-color .2s}
.site-header.scrolled,.site-header:focus-within{border-bottom-color:var(--border)}
.site-header .wrap{display:flex;align-items:center;gap:24px;height:64px}
.site-nav{display:flex;gap:4px;margin-right:auto}
.site-nav a{color:var(--muted);text-decoration:none;font-weight:520;font-size:14px;padding:8px 10px;border-radius:8px}
.site-nav a:hover,.site-nav a[aria-current]{color:var(--text);background:var(--bg-subtle)}
.site-cta{display:flex;align-items:center;gap:8px}
.menu-btn{display:none}
.nav-extra{display:none}
@media (max-width:860px){
  .site-nav{display:none;position:absolute;left:0;right:0;top:64px;background:var(--bg);border-bottom:1px solid var(--border);flex-direction:column;padding:8px 16px 16px;margin:0}
  .site-nav a{padding:14px 10px;font-size:20px;font-weight:600;color:var(--text)}
  /* The open menu is a full-height sheet; the page behind it stays put */
  .nav-open .site-nav{display:flex;height:calc(100dvh - 64px);overflow-y:auto}
  html.nav-open:has(.site-nav) body{overflow:hidden}
  .nav-open .nav-extra{margin-top:auto}
  .menu-btn .i+.i,.nav-open .menu-btn .i:first-child{display:none}
  .nav-open .menu-btn .i+.i{display:block}
  .js .menu-btn{display:inline-grid;width:44px;height:44px}
  .site-header .wrap{gap:12px}
  .site-cta{margin-left:auto;gap:4px}
  .site-cta .hide-sm{display:none}
  /* The main call to action stays in the header, compact; sign-in moves into the menu */
  .site-cta .cta-main{min-height:38px;padding:0 14px;font-size:14px;margin-left:4px}
  .nav-extra{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding-top:12px;margin-top:8px;border-top:1px solid var(--border)}
  .nav-extra .btn{flex:1}
  .nav-extra .btn.primary{flex:1 0 100%}
  .nav-extra .prefs{display:none}
  .nav-extra:not(:has(.btn)){display:none}
  /* Without JavaScript there is no menu button: the links stay in reach as a scrollable row */
  html:not(.js) .site-header .wrap{flex-wrap:wrap;height:auto;min-height:64px;padding-block:10px;row-gap:6px}
  html:not(.js) .site-nav{display:flex;position:static;order:3;flex-direction:row;width:100%;overflow-x:auto;padding:0;border:0;background:none}
  html:not(.js) .site-nav a{padding:8px 10px;font-size:14px;white-space:nowrap}
  html:not(.js) .nav-extra,html:not(.js) .menu-btn{display:none}
}
/* The narrowest phones: shorter header button, and long labels (Russian) wrap instead of pushing the page sideways */
.cta-main .short{display:none}
@media (max-width:359px){
  .cta-main .long{display:none}
  .cta-main .short{display:inline}
  .btn.lg{white-space:normal;text-align:center;line-height:1.25;padding-block:8px}
  .billing-switch{display:flex}
  .billing-switch button{flex:1;white-space:normal;line-height:1.2;padding-block:6px}
}
@media (max-width:420px){
  .site-cta>.prefs{display:none}
  .nav-extra .prefs{display:flex;order:-1;width:100%;justify-content:flex-start}
  .nav-extra:not(:has(.btn)){display:flex}
}

/* Sections */
.section{padding:96px 0}
.section.tight{padding:64px 0}
.section.border{border-top:1px solid var(--border)}
.section-head{max-width:720px;margin:0 0 48px}
.section-head h1,.section-head h2{font-size:clamp(28px,3.6vw,44px);letter-spacing:-.04em;line-height:1.04;margin:0 0 14px;font-weight:700}
.section-head p:not(.eyebrow){font-size:17px;color:var(--muted);margin:0}
.lead{font-size:clamp(17px,1.6vw,19px);color:var(--muted);line-height:1.55}
@media (max-width:640px){.section{padding:64px 0}.section.tight{padding:48px 0}.section-head{margin-bottom:32px}}

/* Shared by the landing and the guide pages (the landing's own blocks live in styles/landing.ts) */
h1,h2{text-wrap:balance}
p{text-wrap:pretty}
.hero-actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center}

/* Services grid */
.svc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.svc{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid var(--border);border-radius:12px;background:var(--card);color:var(--text);text-decoration:none;transition:border-color .15s,transform .15s}
/* A card with a description starts at the top, so titles line up across a row. */
.svc:has(.meta){align-items:flex-start}
a.svc:hover{border-color:var(--border-strong);text-decoration:none;transform:translateY(-1px)}
.svc .name{font-weight:580;display:block}
.svc .meta{font-size:12.5px;color:var(--muted);display:block}
/* Services page: categories flow like a newspaper (CSS columns), so a short category does not leave a
   tall empty gap next to a long one; a long category may continue in the next column, but its title
   stays with its first card and a card is never split. */
.svc-cats{columns:260px 4;column-gap:12px;margin-top:32px}
.svc-cats>[data-filter-group]{display:flow-root;margin:0 0 28px}
.svc-cats .cat-title{break-after:avoid}
.svc-cats .svc{break-inside:avoid}
.svc-cats .cat-title{margin-top:0}
.svc-cats .svc-grid{grid-template-columns:1fr}
/* Not connectable yet: one quiet row of chips under the grid */
.roadmap-list{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}
.road{display:inline-flex;align-items:center;gap:8px;padding:4px 12px 4px 4px;border:1px dashed var(--border-strong);border-radius:999px;color:var(--muted);font-size:13.5px;line-height:1.2;text-decoration:none}
a.road:hover{color:var(--text);border-style:solid;text-decoration:none}
.road .logo-tile.sm{width:26px;height:26px;border-radius:999px}
.road .logo-tile.sm svg{width:14px;height:14px}
.svc-filter{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:0 0 20px}
.svc-filter input{max-width:340px}
.cat-title{font:500 12px/1 ${MONO};letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:32px 0 12px}

/* Pricing */
.billing-switch{display:inline-flex;min-width:0;border:1px solid var(--border);border-radius:10px;padding:3px;background:var(--bg-subtle);margin:0 0 28px}
.billing-switch button{min-height:34px;border:0;background:transparent;color:var(--muted);border-radius:8px}
.billing-switch button[aria-pressed=true]{background:var(--card);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.billing-switch .save{font-size:11px;color:var(--accent-ink);margin-left:4px}
html:not(.js) .billing-switch{display:none}
/* As many plans to a row as fit: the grid follows the number of public plans. */
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;align-items:stretch}
.plan{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px;display:flex;flex-direction:column;gap:16px;position:relative}
@supports (grid-template-rows:subgrid){.plan{display:grid;grid-row:span 4;grid-template-rows:subgrid;row-gap:16px}}
.plan.featured{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.plan .tag{position:absolute;top:-11px;left:20px;background:var(--accent);color:var(--accent-text);font:600 11px/1 ${MONO};letter-spacing:.04em;text-transform:uppercase;border-radius:6px;padding:6px 8px}
.plan .plan-title{font-size:18px;margin:0}
.plan .for{color:var(--muted);font-size:14px;margin:4px 0 0;min-height:42px}
/* With subgrid the rows line up across cards, so a one-line description needs no reserved second line. */
@supports (grid-template-rows:subgrid){.plan .for{min-height:0}}
.price{display:flex;align-items:baseline;gap:6px}
.price .amount{font-size:40px;font-weight:660;letter-spacing:-.04em;line-height:1}
.price .per{color:var(--muted);font-size:14px}
.price-year{color:var(--muted);font-size:13px;min-height:20px}
.js [data-interval=month] .when-year,.js [data-interval=year] .when-month{display:none}
html:not(.js) .when-year{display:none}
.plan ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:9px;font-size:14px}
.plan li{display:flex;gap:10px;align-items:flex-start}
.plan li svg{width:16px;height:16px;flex:none;margin-top:2px;color:var(--accent-ink)}
.plan li.off{color:var(--muted)}
.plan li.off svg{color:var(--muted)}
.plan .btn{margin-top:auto}
@media (max-width:600px){.plans{grid-template-columns:1fr}}
.compare{table-layout:fixed}
.compare th,.compare td{text-align:center}
.compare th:first-child,.compare td:first-child{text-align:left}
.compare td svg{width:18px;height:18px;vertical-align:middle;color:var(--accent-ink)}

/* CTA band */
.cta-band{border:1px solid var(--border-strong);border-radius:20px;padding:56px;background:var(--ink-surface);color:#f5f5f4;display:grid;grid-template-columns:1.4fr 1fr;gap:32px;align-items:center;position:relative;overflow:hidden}
.cta-band h2{font-size:clamp(28px,3.4vw,40px);letter-spacing:-.035em;margin:0 0 10px;line-height:1.08}
.cta-band p{color:#b4b4b8;margin:0}
.cta-band .btn:not(.primary){background:transparent;color:#f5f5f4;border-color:#3a3a3f}
.cta-band .hero-actions{justify-content:flex-end;position:relative;z-index:1}
@media (max-width:860px){.cta-band{grid-template-columns:minmax(0,1fr);padding:32px}.cta-band .hero-actions{justify-content:flex-start}}
@media (max-width:420px){.cta-band{padding:28px 20px}}

/* Docs (connect guides) */
.doc-layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:48px;padding:48px 0 96px}
.doc-nav{position:sticky;top:88px;align-self:start;display:flex;flex-direction:column;gap:2px}
.doc-nav a{color:var(--muted);text-decoration:none;padding:7px 10px;border-radius:8px;font-size:14px;display:flex;align-items:center;gap:10px}
.doc-nav a svg{width:15px;height:15px;fill:currentColor}
.doc-nav a:hover{color:var(--text);background:var(--bg-subtle)}
.doc-nav a[aria-current]{color:var(--text);background:var(--bg-subtle);font-weight:560}
.guide-do{margin:12px 0 6px}
.guide-do p{margin:0 0 10px}
.doc-nav .group{font:500 11px/1 ${MONO};letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:16px 10px 8px}
.guide{scroll-margin-top:88px;padding:0 0 40px;margin:0 0 40px;border-bottom:1px solid var(--border)}
.guide:last-child{border-bottom:0}
.guide h2{display:flex;align-items:center;gap:12px;font-size:24px}
.guide ol{padding-left:22px;margin:12px 0}
.guide ol li{margin:0 0 10px;padding-left:4px}
.guide ol li::marker{font:600 13px ${MONO};color:var(--accent-ink)}
.guide pre.block{white-space:pre;overflow-x:auto}
@media (max-width:860px){.doc-layout{grid-template-columns:minmax(0,1fr);gap:24px;padding-top:24px}.doc-nav{position:static;flex-direction:row;flex-wrap:nowrap;overflow-x:auto;margin:0 -16px;padding:0 16px 4px}
.doc-nav a{white-space:nowrap}.doc-nav .group{display:none}}

/* Prose (legal pages) */
.prose{max-width:760px;padding:48px 0 96px}
.prose h1{font-size:clamp(30px,4vw,42px);letter-spacing:-.035em;margin-bottom:8px}
.prose h2{font-size:20px;margin:36px 0 10px}
.prose p,.prose li{color:var(--text);font-size:15.5px;line-height:1.65}
.prose ul{padding-left:22px}

/* Service page */
.svc-hero{display:flex;gap:20px;align-items:center;margin:8px 0 28px}
.svc-hero .lead{margin:0}
.svc-page{padding-top:48px}
.svc-page .svc-hero{align-items:flex-start;flex-wrap:wrap}
.svc-hero .section-title{font-size:clamp(26px,3.2vw,36px)}
/* On a phone the logo sits above the title, so the text gets the full width. */
@media (max-width:640px){.svc-page .svc-hero{flex-direction:column;gap:14px}.svc-hero>.grow{min-width:0;width:100%}}
.svc-facts{list-style:none;display:flex;flex-wrap:wrap;gap:8px 18px;padding:0;margin:14px 0 0;font-size:14px;color:var(--muted)}
.svc-facts li{display:flex;align-items:center;gap:7px}
.svc-facts svg{width:16px;height:16px;color:var(--accent-ink);flex:none}
.svc-cta{display:flex;flex-direction:column;align-items:center;gap:8px;margin-left:auto;padding-top:6px}
.svc-cta span{text-align:center}
.svc-detail-grid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:16px;align-items:start;margin:0 0 16px}
.svc-detail-grid>.card{margin:0}
.svc-detail-grid h2{margin-bottom:8px}
.tools-table td{vertical-align:top}
.tools-table td:last-child{width:1%;text-align:right}
.tools-table th:last-child{text-align:right}
.tool-id{display:inline-block;margin-top:6px;font-size:11.5px;color:var(--muted);background:none;border:0;padding:0}
.card-head.pad p{margin:4px 0 0}
@media (max-width:900px){.svc-detail-grid{grid-template-columns:1fr}.svc-cta{margin-left:0;align-items:stretch;width:100%}.svc-cta .btn{width:100%}}
@media (max-width:640px){
  .svc-page{padding-top:28px}
  table.stack-sm,table.stack-sm tbody{display:block}
  table.stack-sm thead{display:none}
  table.stack-sm tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:12px 24px;border-top:1px solid var(--border)}
  table.stack-sm td{border:0;padding:0;width:auto}
  .card.flush table.stack-sm td:first-child,.card.flush table.stack-sm td:last-child{padding:0}
}
.section-title{font-size:clamp(28px,3.6vw,40px);letter-spacing:-.03em;margin:0 0 6px;line-height:1.1}
.card-head.pad{padding:20px 24px 4px;margin:0}
.card-head.pad+.table-wrap,.card-head.pad+table{margin-top:12px}
.logo-g{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:#fff;flex:none}
.logo-g svg{width:15px;height:15px}

/* Footer */
.site-footer{border-top:1px solid var(--border);padding:56px 0 40px;margin-top:32px}
.footer-grid{display:grid;grid-template-columns:1.6fr repeat(4,1fr);gap:32px}
.footer-grid h2{font:500 12px/1 ${MONO};letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:4px 0 14px}
.footer-grid a{display:block;color:var(--text);text-decoration:none;font-size:14px;padding:4px 0}
.footer-grid a:hover{color:var(--accent-ink)}
.footer-grid a.brand{display:inline-flex}
.footer-bottom{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:13px;margin-top:40px;padding-top:24px;border-top:1px solid var(--border)}
@media (max-width:760px){.footer-grid{grid-template-columns:1fr 1fr}.footer-grid>div:first-child{grid-column:span 2}.footer-grid a{padding:10px 0}}
.svc-missing{margin-top:24px}
.plan ul{flex:1}
.doc-layout h1{font-size:clamp(32px,4vw,44px);letter-spacing:-.035em;line-height:1.05}
.guide li code,.guide p code{font-size:.92em}
details.more-ways{margin-top:14px}
@media (max-width:640px){.svc-filter input{max-width:none}.svc-missing .row{flex-direction:column;align-items:stretch}.svc-missing .btn{width:100%}}
.compare th:not(:first-child){font-size:14px;font-weight:600;color:var(--text)}
.compare th:first-child,.compare td:first-child{width:30%}
.plans-hint{margin-top:16px;max-width:720px}
.compare tr.group th{text-align:left;font:500 12px/1 ${MONO};letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding-top:18px;border-top:1px solid var(--border)}
/* Phones: the row names stay put while the plans scroll sideways */
@media (max-width:640px){
  .compare{min-width:560px}
  .compare td{background:var(--card)}
  .compare th:first-child,.compare td:first-child{position:sticky;left:0;z-index:1;width:132px;min-width:132px;background:var(--card);box-shadow:1px 0 0 var(--border)}
  .compare thead th:first-child{background:var(--bg-subtle)}
  .compare tr.group th{position:static;box-shadow:none}
}
/* Docs and search pages (src/web/seo-pages.tsx) */
.card.guide{padding:24px;margin:0;border-bottom:1px solid var(--border)}
.card.guide h2,.step-card-plain h2{display:block;font-size:18px}
.compare.vs th,.compare.vs td{text-align:left}
.compare.vs td:first-child{font-weight:560}
.faq-group{margin:0 0 32px}
.faq-group h2{margin:0 0 8px}
.prose .crumbs,.guide .crumbs{margin-bottom:16px}
.wide-cards{grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
/* Use cases, audiences and the blog (src/web/content-pages.tsx) */
.section-sub{margin:40px 0 14px}
.persona-points{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.persona-points .card{margin:0}
.persona-points h2{margin:0 0 6px}
.link-list{padding-left:20px}
.link-list li{margin:4px 0}
.prose .svc-grid,.prose .prompt-list{margin:12px 0 0}
.prose .prompt-list{padding-left:0}
.post-list{display:grid;gap:12px;max-width:760px}
.post-card{display:block;margin:0;color:inherit;text-decoration:none}
.post-card:hover{border-color:var(--accent)}
.post-card h2{margin:4px 0 6px}
.post-card p{margin:0}
@media (max-width:640px){.wide-cards{grid-template-columns:1fr}}

/* Trust page (src/web/trust-page.tsx) */
.trust{padding-top:48px;padding-bottom:64px}
.trust-head{margin-bottom:32px}
.trust-head p.small{margin-top:10px}
.trust-glance{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.trust-glance .card{margin:0}
.trust-glance h2{font-size:17px;margin:14px 0 6px}
.trust-glance p{margin:0;font-size:14.5px;line-height:1.55}
.trust-icon{display:inline-grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--accent-soft);color:var(--accent-ink)}
.trust-icon svg{width:18px;height:18px}
.trust-section{margin-top:56px;scroll-margin-top:88px}
.trust-section>h2{font-size:clamp(22px,2.6vw,28px);letter-spacing:-.02em;margin:0 0 6px}
.trust-section>p.muted{margin:0 0 18px;max-width:720px}
.trust-table td{vertical-align:top;line-height:1.55;padding-top:14px;padding-bottom:14px}
.trust-table td:first-child{font-weight:560;width:26%}
.trust-table td p{margin:8px 0 0}
.trust-table th:nth-child(2){width:40%}
.trust-parties{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.trust-parties .card{margin:0}
.trust-parties h3{font-size:17px;margin:0 0 12px}
.trust-label{font:500 11px/1 ${MONO};letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:14px 0 8px}
.trust-points{list-style:none;padding:0;margin:0;display:grid;gap:8px}
.trust-points li{display:flex;gap:10px;align-items:flex-start;font-size:14.5px;line-height:1.5}
.trust-points svg{width:16px;height:16px;flex:none;margin-top:3px;color:var(--accent-ink)}
.trust-points.never svg{color:var(--muted)}
.trust-steps{list-style:none;padding:0;margin:0 0 16px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;counter-reset:step}
.trust-steps li.card{margin:0;counter-increment:step}
.trust-steps h3{font-size:16px;margin:0 0 8px;display:flex;gap:10px;align-items:baseline}
.trust-steps h3::before{content:counter(step);font:600 13px ${MONO};color:var(--accent-ink)}
.trust-steps p{margin:0;font-size:14.5px;line-height:1.55}
.trust .bullets{max-width:760px}
.trust .bullets li{line-height:1.6}
@media (max-width:900px){.trust-glance,.trust-steps{grid-template-columns:minmax(0,1fr)}}
@media (max-width:640px){
  .trust{padding-top:28px}
  .trust-section{margin-top:40px}
  .trust-parties{grid-template-columns:minmax(0,1fr)}
  .trust-table,.trust-table tbody,.trust-table tr,.trust-table td{display:block;width:auto}
  .trust-table thead{display:none}
  .trust-table tr{padding:16px 20px;border-top:1px solid var(--border)}
  .trust-table tr:first-child{border-top:0}
  .card.flush table.trust-table td,.card.flush table.trust-table td:first-child,.card.flush table.trust-table td:last-child{border:0;padding:0;width:auto}
  .trust-table td+td{margin-top:12px}
  .trust-table td[data-label]::before{content:attr(data-label);display:block;font:500 11px/1.4 ${MONO};letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
}

/* Status page */
.status-wrap{max-width:880px;padding-top:40px;padding-bottom:64px}
.status-wrap h1{margin:0 0 20px}
.status-banner{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline;justify-content:space-between;padding:18px 20px;border-radius:var(--radius);margin:0 0 20px;border:1px solid transparent}
.status-banner strong{font-size:18px}
.status-banner.s-ok{background:var(--ok-soft);color:var(--ok)}
.status-banner.s-degraded{background:var(--warn-bg);border-color:var(--warn-border);color:var(--text)}
.status-banner.s-down{background:var(--danger-soft);color:var(--danger)}
.status-banner.s-none{background:var(--bg-subtle);color:var(--muted)}
.status-banner .small{color:var(--text);opacity:.8}
.status-component{padding:20px}
.status-component+.status-component{border-top:1px solid var(--border)}
.status-head{display:flex;gap:12px;justify-content:space-between;align-items:flex-start}
.status-head h2{font-size:16px;margin:0}
.status-head p{margin:4px 0 0}
.status-state{font-weight:600;font-size:14px;text-align:right;white-space:nowrap}
.status-state.s-ok{color:var(--ok)}
.status-state.s-degraded{color:var(--text)}
.status-state.s-down{color:var(--danger)}
.status-bars{display:grid;grid-template-columns:repeat(90,1fr);gap:2px;height:32px;margin:14px 0 6px}
.status-bar{border-radius:2px;background:var(--border)}
.status-bar.s-ok{background:var(--ok)}
.status-bar.s-degraded{background:var(--warn-border)}
.status-bar.s-down{background:var(--danger)}
.status-bar.s-missing{background:var(--muted)}
.status-scale{display:flex;justify-content:space-between;gap:8px}
.status-section{font-size:18px;margin:32px 0 12px}
.status-incidents li{display:flex;gap:10px;align-items:baseline;padding:10px 0;border-bottom:1px solid var(--border)}
.status-foot{margin-top:32px}
@media (max-width:640px){
  .status-bars{grid-template-columns:repeat(30,1fr)}
  .status-bars .status-bar:nth-child(-n+60){display:none}
  .status-scale span:first-child{visibility:hidden}
}
`;
