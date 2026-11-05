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
.site-nav a:hover,.site-nav a[aria-current=page]{color:var(--text);background:var(--bg-subtle)}
.site-cta{display:flex;align-items:center;gap:8px}
.menu-btn{display:none}
.nav-extra{display:none}
@media (max-width:860px){
  .site-nav{display:none;position:absolute;left:0;right:0;top:64px;background:var(--bg);border-bottom:1px solid var(--border);flex-direction:column;padding:8px 16px 16px;margin:0}
  .site-nav a{padding:12px 10px;font-size:16px}
  .nav-open .site-nav{display:flex}
  .menu-btn{display:inline-grid}
  .site-header .wrap{gap:12px}
  .site-cta{margin-left:auto}
  .site-cta .hide-sm{display:none}
  .site-cta .cta-main{display:none}
  .nav-extra{display:flex;gap:8px;padding-top:12px;margin-top:8px;border-top:1px solid var(--border)}
  .nav-extra .btn{flex:1}
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

/* Hero */
.hero{padding:72px 0 88px;position:relative;overflow:hidden}
.hero .wrap{position:relative;display:grid;grid-template-columns:minmax(0,1.02fr) minmax(0,1fr);gap:56px;align-items:center}
.hero h1{font-size:clamp(40px,5.6vw,68px);line-height:1.02;letter-spacing:-.045em;font-weight:660;margin:0 0 22px}
.hero h1 .mark{color:var(--accent-ink)}
h1,h2{text-wrap:balance}
p{text-wrap:pretty}
.hero .lead{max-width:540px;margin:0 0 30px}
.hero-actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
/* On a phone the hero buttons are full width, one under the other, so neither floats. */
@media (max-width:520px){.hero .hero-actions{flex-direction:column;align-items:stretch}.hero .hero-actions .btn{width:100%}}
.hero-note{margin:18px 0 0;color:var(--muted);font-size:13px;display:flex;gap:16px;flex-wrap:wrap}
.hero-note span{display:inline-flex;align-items:center;gap:6px}
.hero-note svg{width:14px;height:14px;color:var(--accent-ink)}
@media (max-width:960px){.hero .wrap{grid-template-columns:1fr;gap:40px}.hero{padding:40px 0 64px}}

/* Product demo window */
.demo{background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 0 rgba(0,0,0,.03),0 24px 60px -28px rgba(0,0,0,.28);overflow:hidden;font-size:14px}
.demo-bar{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border);font:600 14px/1.2 inherit;color:var(--muted)}
.demo-avatar{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:#d97757;color:#fff;flex:none}
.demo-avatar svg{width:15px;height:15px;fill:currentColor}
.demo-status{display:inline-flex;align-items:center;gap:6px;font-weight:500;font-size:12px;color:var(--muted);padding:5px 9px;border-radius:999px;background:var(--bg-subtle)}
.demo-input{display:flex;align-items:center;gap:10px;margin:0 16px 16px;padding:12px 14px;border:1px solid var(--border);border-radius:14px;color:var(--muted);font-size:14px}
.demo-input svg{width:16px;height:16px;flex:none}
.demo-bar .grow{text-align:left}
.demo-body{padding:20px;display:flex;flex-direction:column;gap:12px}
.msg{max-width:88%;padding:11px 14px;border-radius:14px;line-height:1.5}
.msg.user{align-self:flex-end;background:var(--bg-subtle);border:1px solid var(--border);border-bottom-right-radius:4px}
.msg.ai{align-self:flex-start;padding-left:0;padding-right:0;color:var(--text)}
.call{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--border);border-radius:10px;font:450 12.5px/1.4 ${MONO};background:var(--code-bg)}
.call b{font-weight:600;color:var(--text)}
.call .args{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.call .res{color:var(--ok);white-space:nowrap}
.call .res.wait{color:var(--accent-ink)}
.demo .step{opacity:0;transform:translateY(6px);animation:rise .5s ease forwards}
.demo .s1{animation-delay:0s}.demo .s2{animation-delay:.6s}.demo .s3{animation-delay:1.2s}.demo .s4{animation-delay:1.8s}.demo .s5{animation-delay:2.4s}
@media (prefers-reduced-motion:reduce){.demo .step{opacity:1;transform:none;animation:none}}
@keyframes rise{to{opacity:1;transform:none}}
@media (max-width:520px){.call{grid-template-columns:auto 1fr}.call .res{grid-column:2}}

/* Works-with strip */

/* Steps */
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;counter-reset:step}
.step-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:24px;display:flex;flex-direction:column;gap:12px}
.step-card .n{font:600 12px/1 ${MONO};color:var(--accent-ink);background:var(--accent-soft);border-radius:6px;padding:6px 8px;align-self:flex-start}
.step-card h3{font-size:18px;margin:4px 0 0}
.step-card p{color:var(--muted);margin:0}
.step-card .visual{margin-top:auto;padding-top:8px}
.visual.stack{display:flex;flex-direction:column;gap:8px}
.url-pill{display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px dashed var(--border-strong);border-radius:10px;font:500 13px/1 ${MONO};background:var(--code-bg);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.prompt-pill{padding:10px 12px;border-radius:12px;background:var(--bg-subtle);border:1px solid var(--border);font-size:14px}
@media (max-width:860px){.steps{grid-template-columns:1fr}}

/* Hub diagram */
.hubmap{display:grid;grid-template-columns:1fr auto 1fr;gap:0;align-items:center}
.hubmap-col{display:flex;flex-direction:column;gap:10px}
.hubmap-col.right{align-items:stretch}
.node{display:flex;align-items:center;gap:10px;padding:10px 14px;border:1px solid var(--border);border-radius:12px;background:var(--card);font-weight:540;position:relative}
.node svg{width:18px;height:18px;fill:currentColor;flex:none}
.node .accs{margin-left:auto;display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.node .acc{font:500 11px/1 ${MONO};color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:4px 6px;background:var(--bg-subtle)}
.hubmap-col.left .node::after,.hubmap-col.right .node::before{content:"";position:absolute;top:50%;width:48px;border-top:1px dashed var(--border-strong)}
.hubmap-col.left .node::after{left:100%}
.hubmap-col.right .node::before{right:100%}
.hub-core{margin:0 48px;padding:22px 20px;border-radius:18px;background:var(--ink-surface);color:#f5f5f4;box-shadow:0 0 0 1px var(--border-strong);text-align:center;min-width:220px;position:relative}
.hub-core .brand-mark{width:36px;height:36px;margin:0 auto 10px;display:block}
.hub-core strong{display:block;font-size:17px;letter-spacing:-.02em}
.hub-core code{display:inline-block;margin-top:10px;background:transparent;border-color:currentColor;color:inherit;opacity:.85}
@media (max-width:960px){
  .hubmap{grid-template-columns:1fr;gap:20px}
  .hub-core{margin:0}
  .hubmap-col.left .node::after,.hubmap-col.right .node::before{display:none}
  .hubmap-col.left{flex-direction:row;flex-wrap:wrap}
  .hubmap-col.left .node{flex:1 1 140px}
}

/* Bento */
.bento{display:grid;grid-template-columns:repeat(6,1fr);gap:16px}
.tile{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:26px;display:flex;flex-direction:column;gap:10px;min-height:260px;overflow:hidden}
.tile h3{font-size:19px;margin:0;letter-spacing:-.02em}
.tile p{color:var(--muted);margin:0}
.tile .visual{margin-top:auto}
.tile.c2{grid-column:span 2}.tile.c3{grid-column:span 3}.tile.c4{grid-column:span 4}
@media (max-width:960px){.bento{grid-template-columns:1fr 1fr}.tile.c2,.tile.c3,.tile.c4{grid-column:span 2}}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:6px;font:500 12px/1 ${MONO};padding:7px 9px;border:1px solid var(--border);border-radius:8px;background:var(--bg-subtle);color:var(--text)}
.chip svg{width:13px;height:13px;fill:currentColor}
.chip.on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-ink)}
.bars{display:flex;flex-direction:column;gap:10px;font-size:13px}
.bars .bar{display:grid;grid-template-columns:120px 1fr auto;gap:10px;align-items:center}
.bars .meter{height:10px}
.bars .meter.dim>span{background:var(--border-strong)}
.ask{border:1px solid var(--border);border-radius:12px;padding:12px 14px;background:var(--bg-subtle);font-size:13.5px}
.ask .who{font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:6px}
.ask .who svg{width:14px;height:14px;color:var(--accent-ink)}
.ask .btns{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px}
.ask .btns span{text-align:center;border-radius:8px;padding:7px;background:var(--card);border:1px solid var(--border);font-weight:560}
.ask .btns span.yes{border-color:var(--accent);color:var(--accent-ink)}
.codebox{background:var(--code-bg);border:1px solid var(--border);border-radius:10px;padding:12px 14px;font:450 12.5px/1.6 ${MONO};white-space:pre;overflow-x:auto;color:var(--muted)}
.codebox b{color:var(--text);font-weight:600}
.codebox i{font-style:normal;color:var(--accent-ink)}

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

/* Security list */
.sec-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.sec-item{background:var(--card);padding:24px}
.sec-item h3{font-size:16px;margin:0 0 6px;display:flex;align-items:center;gap:10px}
.sec-item h3 svg{width:18px;height:18px;color:var(--accent-ink);flex:none}
.sec-item p{color:var(--muted);margin:0;font-size:14px}
@media (max-width:860px){.sec-grid{grid-template-columns:1fr}}

/* Pricing */
.billing-switch{display:inline-flex;min-width:0;border:1px solid var(--border);border-radius:10px;padding:3px;background:var(--bg-subtle);margin:0 0 28px}
.billing-switch button{min-height:34px;border:0;background:transparent;color:var(--muted);border-radius:8px}
.billing-switch button[aria-pressed=true]{background:var(--card);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.billing-switch .save{font-size:11px;color:var(--accent-ink);margin-left:4px}
html:not(.js) .billing-switch{display:none}
.plans{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;align-items:stretch}
.plan{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px;display:flex;flex-direction:column;gap:16px;position:relative}
.plan.featured{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.plan .tag{position:absolute;top:-11px;left:20px;background:var(--accent);color:var(--accent-text);font:600 11px/1 ${MONO};letter-spacing:.04em;text-transform:uppercase;border-radius:6px;padding:6px 8px}
.plan h3{font-size:18px;margin:0}
.plan .for{color:var(--muted);font-size:14px;margin:4px 0 0;min-height:42px}
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
@media (max-width:1060px){.plans{grid-template-columns:1fr 1fr}}
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
@media (max-width:860px){.cta-band{grid-template-columns:1fr;padding:32px}.cta-band .hero-actions{justify-content:flex-start}}

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
.footer-grid h4{font:500 12px/1 ${MONO};letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:4px 0 14px}
.footer-grid a{display:block;color:var(--text);text-decoration:none;font-size:14px;padding:4px 0}
.footer-grid a:hover{color:var(--accent-ink)}
.footer-grid a.brand{display:inline-flex}
.footer-bottom{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:13px;margin-top:40px;padding-top:24px;border-top:1px solid var(--border)}
@media (max-width:760px){.footer-grid{grid-template-columns:1fr 1fr}.footer-grid>div:first-child{grid-column:span 2}}
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
