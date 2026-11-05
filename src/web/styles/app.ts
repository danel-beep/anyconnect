import { SANS } from '../assets.js';

/** The signed-in area (dashboard and admin panel): sidebar, page header, stats, lists. */
export const APP_SHELL_CSS = `
.shell{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh;background:linear-gradient(to right,var(--bg-subtle) 247px,var(--border) 247px,var(--border) 248px,transparent 248px)}
.sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:4px;padding:18px 14px;border-right:1px solid var(--border);background:var(--bg-subtle);overflow-y:auto}
.sidebar .brand{padding:6px 8px 18px}
.side-group{font:600 11.5px/1 ${SANS};letter-spacing:.04em;text-transform:uppercase;color:var(--muted);padding:18px 10px 8px}
.side-link{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;color:var(--muted);text-decoration:none;font-weight:540;font-size:14px}
.side-link svg{width:17px;height:17px;flex:none}
.side-link:hover{color:var(--text);background:var(--card);text-decoration:none}
.side-link[aria-current=page]{color:var(--text);background:var(--card);box-shadow:inset 0 0 0 1px var(--border)}
.side-link .count{margin-left:auto;font:650 11px/1 ${SANS};font-variant-numeric:tabular-nums;background:var(--accent);color:var(--accent-text);border-radius:99px;padding:4px 7px}
.side-link .count.bad{background:var(--danger);color:#fff}
.side-foot{margin-top:auto;padding-top:16px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:10px}
.who{display:flex;align-items:center;gap:10px;padding:4px 6px;min-width:0}
.avatar{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent-ink);font-weight:650;font-size:13px;flex:none;text-transform:uppercase}
.who .grow{overflow:hidden}
.who .email{font-size:13px;font-weight:560;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.who .plan-name{font-size:12px;color:var(--muted);display:block}
.side-tools{display:flex;align-items:center;gap:4px;padding:0 2px}
.side-tools .prefs{margin-right:auto}
.side-tools form.inline{display:flex}
.content{min-width:0;padding:28px 40px 72px;max-width:1120px;width:100%;margin-inline:auto}
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:0 0 24px;flex-wrap:wrap}
.page-head h1{font-size:26px;letter-spacing:-.03em;margin:0}
.page-head p{margin:6px 0 0;color:var(--muted)}
.crumbs{font-size:13px;color:var(--muted);margin:0 0 8px}
.crumbs a{color:var(--muted)}
.mobile-bar{display:none}
@media (max-width:900px){
  .shell{grid-template-columns:1fr;background:none}
  .sidebar{position:fixed;inset:0 30% 0 0;max-width:300px;z-index:40;transform:translateX(-102%);transition:transform .2s;height:100%;box-shadow:0 0 0 100vmax rgba(0,0,0,0)}
  .nav-open .sidebar{transform:none;box-shadow:0 0 0 100vmax rgba(0,0,0,.35)}
  .mobile-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border);background:var(--bg);position:sticky;top:0;z-index:30}
  .content{padding:20px 16px 56px}
}

/* Stats */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:0 0 16px}
.stat{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;min-width:0}
.stat .label{font-size:13px;color:var(--muted);display:flex;align-items:center;justify-content:space-between;gap:8px}
.stat .value{font-size:26px;font-weight:640;letter-spacing:-.03em;margin:6px 0 2px;font-variant-numeric:tabular-nums}
.stat .sub{font-size:12.5px;color:var(--muted)}
.stat .meter{margin-top:10px}
a.stat{color:inherit;text-decoration:none}
a.stat:hover{border-color:var(--border-strong)}
@media (max-width:1000px){.stats{grid-template-columns:1fr 1fr}}
@media (max-width:520px){.stats{grid-template-columns:1fr 1fr}}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
@media (max-width:1000px){.grid-2,.grid-3{grid-template-columns:1fr}}
.grid-2>.card,.grid-3>.card{margin:0}
.grid-2,.grid-3{margin-bottom:16px;align-items:start}

/* Onboarding */
.onboard{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:0 0 16px}
.onboard-step{border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;background:var(--card);display:flex;gap:12px;align-items:flex-start;color:var(--text);text-decoration:none}
a.onboard-step:hover{border-color:var(--border-strong);text-decoration:none}
.onboard-step .tick{width:24px;height:24px;border-radius:50%;border:1.5px solid var(--border-strong);display:grid;place-items:center;flex:none;font:650 12px/1 ${SANS};color:var(--muted)}
.onboard-step.done .tick{background:var(--ok);border-color:var(--ok);color:var(--card)}
.onboard-step.done .tick svg{width:14px;height:14px}
.onboard-step strong{display:block;font-size:14.5px}
.onboard-step span{font-size:13px;color:var(--muted)}
@media (max-width:900px){.onboard{grid-template-columns:1fr}}

/* Account rows */
.acc-list{display:flex;flex-direction:column}
.acc{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:14px;align-items:center;padding:14px 20px;border-top:1px solid var(--border)}
.acc:first-child{border-top:0}
.acc .title{font-weight:580;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.acc .sub{font-size:13px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acc .ops{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.acc details{border:0}
.acc details:last-of-type{border:0}
.acc summary{padding:0;font-size:13px;font-weight:560}
.acc summary::after{display:none}
.menu{position:relative}
.menu>summary{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:8px;border:1px solid var(--border-strong);color:var(--muted)}
.menu>summary:hover{color:var(--text)}
.menu>summary svg{width:16px;height:16px}
.menu-pop{position:absolute;right:0;top:38px;z-index:10;min-width:220px;background:var(--card);border:1px solid var(--border);border-radius:12px;box-shadow:0 12px 32px -12px rgba(0,0,0,.3);padding:6px;display:flex;flex-direction:column}
.menu-pop form{margin:0}
.menu-pop button,.menu-pop a{width:100%;justify-content:flex-start;border:0;background:none;min-height:36px;padding:0 10px;border-radius:8px;font-weight:500;color:var(--text);text-decoration:none;display:flex;align-items:center;gap:8px}
.menu-pop button:hover,.menu-pop a:hover{background:var(--bg-subtle)}
.menu-pop button.danger{color:var(--danger)}
.menu-pop .rename{display:flex;gap:6px;padding:6px}
.menu-pop .rename input{min-height:34px;padding:6px 10px}
.menu-pop svg{width:16px;height:16px;flex:none}
/* With JS the open menu floats above the page (placed by site.js), so no card clips it; without JS the card lets it show. */
.menu-pop.floating{position:fixed;right:auto;z-index:60;max-height:calc(100vh - 16px);overflow:auto}
.card.flush:has(details[data-menu]){overflow:visible}
@media (max-width:640px){.acc{grid-template-columns:auto minmax(0,1fr)}.acc .ops{grid-column:1/-1;justify-content:flex-start}}

/* Catalog in the dashboard: a search bar, a short popular row and the full list folded below it.
   While the list is open the bar sticks to the top with category filters and "Show fewer". */
.add-card{scroll-margin-top:12px}
.add-head{display:block}
.add-head p{margin:4px 0 0}
.svc-bar{display:flex;flex-direction:column;gap:10px;margin:0 0 4px}
.svc-bar-row{display:flex;gap:10px;align-items:center}
.search-box{position:relative;flex:1 1 auto;min-width:0}
.search-box>svg{position:absolute;left:12px;top:50%;width:16px;height:16px;transform:translateY(-50%);color:var(--muted);pointer-events:none}
.search-box input{padding-left:38px!important;padding-right:40px!important;min-height:42px!important}
.search-box input::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none;display:none}
.search-clear{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:30px;height:30px;min-height:0;padding:0;border:0;border-radius:8px;background:transparent;color:var(--muted);display:grid;place-items:center}
.search-clear[hidden]{display:none}
.search-clear:hover{color:var(--text);background:var(--bg-subtle)}
.search-clear svg{width:16px;height:16px}
.svc-fewer{flex:none;gap:6px}
.svc-fewer svg{width:16px;height:16px}
.svc-fewer:not([hidden]),.svc-chips:not([hidden]){display:none}
.add-card:has(details.svc-all[open]) .svc-fewer:not([hidden]){display:inline-flex}
.add-card:has(details.svc-all[open]) .svc-chips:not([hidden]){display:flex}
.add-card:has(details.svc-all[open]) .svc-bar{position:sticky;top:0;z-index:6;background:var(--card);margin:0 -24px;padding:12px 24px;border-bottom:1px solid var(--border);box-shadow:0 10px 18px -16px rgba(0,0,0,.45)}
.add-card:has(details.svc-all[open]) #popular{display:none}
.svc-chips-wrap{position:relative;margin:0 -24px}
.svc-chips{border:0;min-width:0;gap:6px;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin:0;padding:0 24px}
.svc-chips:not(.at-end){mask-image:linear-gradient(to right,#000 85%,transparent);-webkit-mask-image:linear-gradient(to right,#000 85%,transparent)}
.svc-chips.scrolled.at-end{mask-image:linear-gradient(to right,transparent,#000 8%);-webkit-mask-image:linear-gradient(to right,transparent,#000 8%)}
.svc-chips.scrolled:not(.at-end){mask-image:linear-gradient(to right,transparent,#000 8%,#000 85%,transparent);-webkit-mask-image:linear-gradient(to right,transparent,#000 8%,#000 85%,transparent)}
.chips-arrow{display:none;cursor:pointer;position:absolute;top:50%;transform:translateY(-50%);width:30px;height:30px;min-height:0;padding:0;border-radius:50%;border:1px solid var(--border-strong);background:var(--card);color:var(--text);place-items:center;box-shadow:0 2px 8px -3px rgba(0,0,0,.3);z-index:1}
.chips-arrow.next{right:14px}
.chips-arrow.prev{left:14px}
.chips-arrow svg{width:16px;height:16px;transform:rotate(-90deg)}
.chips-arrow.prev svg{transform:rotate(90deg)}
@media (hover:hover){.add-card:has(details.svc-all[open]) .chips-arrow:not([hidden]){display:grid}}
.label-short{display:none}
.link-btn{border:0;background:none;padding:0;min-height:0;font:inherit;color:var(--accent-ink);text-decoration:underline;cursor:pointer}
.svc-chips::-webkit-scrollbar{display:none}
.svc-chips button{flex:none;min-height:32px;padding:0 12px;font-size:13px;font-weight:540;border-radius:99px;border:1px solid var(--border);background:var(--card);color:var(--muted)}
.svc-chips button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
[data-chip-off]{display:none!important}
.svc-section{font:600 12px/1.2 ${SANS};letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:20px 0 10px;scroll-margin-top:170px}
.svc-section .muted{text-transform:none;letter-spacing:0;font-weight:500}
[data-searching] .svc-section .muted{display:none}
#popular .svc-section{margin-top:14px}
.svc-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
@media (max-width:1100px){.svc-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.svc-tile{position:relative;display:flex;gap:12px;align-items:center;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--card);min-width:0;scroll-margin-top:160px;transition:border-color .15s,background .15s}
.svc-tile:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
.svc-tile .grow{min-width:0}
.svc-tile .logo-tile{flex:none}
.svc-name{display:flex;align-items:center;gap:6px;min-width:0}
.svc-name a,.svc-name strong{font-weight:600;font-size:14.5px;color:var(--text);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.svc-name a:focus-visible{outline:none}
.svc-name .tiny-badge{margin-left:0;flex:none}
a.stretch::after{content:"";position:absolute;inset:0;border-radius:inherit}
.svc-tile p{margin:2px 0 0;font-size:12.5px;line-height:1.4;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.svc-go{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:8px;color:var(--accent-ink);transition:background .15s}
.svc-go svg{width:16px;height:16px}
.svc-tile.off{background:var(--bg-subtle);align-items:flex-start}
.svc-tile.off .logo-tile{opacity:.6}
.svc-tile.off p{-webkit-line-clamp:3}
.svc-tile .cat-unavailable{margin-top:6px;position:relative;z-index:1}
.cat-unavailable{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center}
.svc-none{margin:16px 0 0}
details.svc-all{border:0;margin-top:12px}
details.svc-all:last-of-type{border:0}
details.svc-all>summary{display:flex;justify-content:center;align-items:center;padding:0;font-size:14px;font-weight:600;color:var(--text);min-height:44px;border:1px dashed var(--border-strong);border-radius:10px;background:var(--card)}
details.svc-all>summary::after{display:none}
details.svc-all>summary span{display:inline-flex;align-items:center;gap:6px}
details.svc-all>summary svg{width:16px;height:16px}
.svc-all svg.up,.svc-bar svg.up{transform:rotate(180deg)}
details.svc-all .when-open,details.svc-all[open] .when-closed{display:none}
details.svc-all[open] .when-open{display:inline-flex}
.js details.svc-all[open]>summary{display:none}
details.svc-all[data-searching] .svc-collapse{display:none}
details.svc-all>div{padding:0;color:inherit;max-width:none}
.svc-collapse{margin-top:18px}
.svc-collapse svg{width:16px;height:16px}
@media (hover:hover){
  .svc-tile:not(.off):hover{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 4%,var(--card))}
  .svc-tile:not(.off):hover .svc-go{background:var(--accent-soft)}
  details.svc-all>summary:hover{border-color:var(--accent);color:var(--accent-ink)}
  .svc-chips button:not([aria-pressed=true]):hover{color:var(--text);border-color:var(--border-strong)}
}
@media (max-width:900px){
  .add-card:has(details.svc-all[open]) .svc-bar{top:65px}
  .svc-section{scroll-margin-top:200px}
  .add-card{scroll-margin-top:76px}
  .svc-tile{scroll-margin-top:210px}
}
@media (max-width:640px){
  .svc-grid{grid-template-columns:1fr;gap:6px}
  .svc-grid.popular .svc-tile:nth-child(n+7){display:none}
  .svc-tile{padding:9px 10px;gap:10px}
  .label-long{display:none}
  .label-short{display:inline}
  .add-jump .btn-label{display:none}
  .add-jump{padding-inline:10px}
}
.acc-sample{background:var(--bg-subtle)}
.acc .sub.sub-wrap,.acc .sub.error{white-space:normal}
details.card.fold{padding:0}
details.card.fold:last-of-type{border-bottom:1px solid var(--border)}
details.fold>summary{display:flex;gap:12px;align-items:center;padding:18px 52px 18px 24px}
details.fold>summary::after{right:24px}
details.fold .fold-title{display:flex;align-items:center;gap:8px;font-size:17px;font-weight:620}
details.fold .fold-sub{display:block;font-weight:400;margin-top:4px}
details.fold>.fold-body{padding:0 24px 20px;max-width:none;color:inherit}

/* Activity chart */
.chart{display:flex;align-items:flex-end;gap:3px;height:120px;padding:8px 0 0;border-bottom:1px solid var(--border)}
.chart .col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;min-width:3px}
.chart .col span{display:block;background:var(--accent);border-radius:3px 3px 0 0;min-height:2px}
.chart .col.zero span{background:var(--border)}
.chart .col span.err{background:var(--danger);border-radius:3px 3px 0 0}
.chart .col span.err+span{border-radius:0}
.log-filters{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center;padding-bottom:14px}
.log-filters select{width:auto;min-width:180px;max-width:100%;min-height:36px;padding:6px 10px;font-size:14px}
.log-filters .check{margin:0;font-size:14px}
@media (max-width:640px){.log-filters select{flex:1 1 100%}}
.chart-axis{display:flex;justify-content:space-between;font:500 11.5px/1 ${SANS};font-variant-numeric:tabular-nums;color:var(--muted);padding-top:8px}
.top-list{display:flex;flex-direction:column;gap:10px}
.top-list .bar{display:grid;grid-template-columns:minmax(0,1fr) 120px auto;gap:12px;align-items:center;font-size:13.5px}
.top-list .bar .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Plan cards in the dashboard */
.plan-mini{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.focus-plan{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}
.focus-plan form{max-width:320px}
.paid-sub{margin:12px 0}
.paid-sub .actions{margin-top:8px;flex-wrap:wrap}
.billing-events{margin:12px 0}
.billing-events li{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.start-schedule{margin:12px 0}
.start-schedule li{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.start-schedule li.past{opacity:.55}
.start-schedule li.current{font-weight:600}
.start-schedule .badge{margin-left:8px}
.plan-mini .plan{padding:18px;gap:10px}
.plan-mini .price .amount{font-size:28px}
.plan.current{border-color:var(--ok);box-shadow:0 0 0 1px var(--ok)}
@media (max-width:1100px){.plan-mini{grid-template-columns:1fr 1fr}}
@media (max-width:560px){.plan-mini{grid-template-columns:1fr}}

/* Danger zone */
.danger-zone{border-color:var(--danger)}
.danger-zone h2{color:var(--danger)}

.pad-x{padding:0 24px 16px;margin:0}
ul.plain.pad-x{padding:0 24px 6px}
.wide-2{grid-column:span 2}
@media (max-width:640px){.wide-2{grid-column:auto}}
.search-sm{max-width:260px;min-height:36px!important;padding:6px 12px!important}
.tiny-badge{margin-left:6px;padding:3px 7px}
.guide-compact pre.block{white-space:pre;overflow-x:auto;margin-top:8px}
.guide-compact ol{margin-top:0}

/* Admin */
.admin-tag{font:650 10.5px/1 ${SANS};letter-spacing:.05em;text-transform:uppercase;background:var(--accent-soft);color:var(--accent-ink);border-radius:5px;padding:4px 6px;margin-left:6px}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 14px}
.filters input[type=search]{max-width:320px}
.filters select{width:auto;min-width:150px}
.pager{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 20px;border-top:1px solid var(--border);font-size:13px;color:var(--muted)}
.user-cell{display:flex;align-items:center;gap:10px;min-width:0}
.user-cell a{font-weight:560;color:var(--text);text-decoration:none}
.user-cell a:hover{text-decoration:underline}
.inline-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;align-items:end}
.inline-form label{margin:0 0 6px}
.inline-form .wide{grid-column:1/-1}
@media (max-width:520px){.copy{flex-direction:column}.copy button{width:100%}}
@media (max-width:640px){.lang-link,.crumbs a,.icon-btn{min-height:40px;min-width:40px;display:inline-grid;place-items:center}}
.choice-list{border:0;padding:0;margin:0 0 16px;display:grid;gap:8px}
.choice{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border:1px solid var(--border);border-radius:12px;cursor:pointer}
.choice:has(input:checked){border-color:var(--accent);background:var(--accent-soft)}
.choice input{margin-top:3px;width:auto}
.choice span{display:flex;flex-direction:column;gap:2px}
.rule-list{display:flex;flex-direction:column}
.rule-row{display:grid;grid-template-columns:minmax(0,1fr) 290px 290px auto;gap:12px;align-items:end;padding:12px 0;border-top:1px solid var(--border)}
.rule-row:first-child{border-top:0}
.rule-row label{margin:0 0 4px;display:block}
.rule-who{display:flex;gap:10px;align-items:center}
/* Confirmations */
.pending-call{display:flex;flex-direction:column;gap:12px}
.pending-call.open{border-color:color-mix(in srgb,var(--accent) 45%,var(--border))}
.pending-head{display:flex;gap:14px;align-items:flex-start}
.pending-head h1,.pending-head h2{margin:0 0 2px}
.pending-head p{margin:0}
.pending-meta{margin:0}
.pending-args summary{cursor:pointer;font-size:13px;color:var(--muted)}
.arg-list{margin:8px 0 0;border:1px solid var(--border);border-radius:10px;background:var(--code-bg);max-height:420px;overflow:auto}
.arg-list>div{display:grid;grid-template-columns:140px minmax(0,1fr);gap:12px;padding:10px 14px;border-top:1px solid var(--border)}
.arg-list>div:first-child{border-top:0}
.arg-list dt{font-size:13px;color:var(--muted)}
.arg-list dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}
@media (max-width:560px){.arg-list>div{grid-template-columns:1fr;gap:2px}}
.pending-actions{margin:0}
.pending-actions button svg{width:16px;height:16px}
.empty-state{text-align:center;padding:40px 24px}
.empty-state p{max-width:52ch;margin-left:auto;margin-right:auto}
.empty-icon{display:inline-grid;place-items:center;width:44px;height:44px;border-radius:50%;background:var(--ok-soft);color:var(--ok);margin-bottom:10px}
.empty-icon svg{width:22px;height:22px;stroke-width:2.4}
.rule-who>span{display:flex;flex-direction:column;min-width:0}
.rule-who .small{overflow-wrap:anywhere}
.rule-list .acc-group{padding:18px 0 2px;background:none;border-top:0}
.rule-list .acc-group:first-child{padding-top:4px}
.rule-list .acc-group+.rule-row{border-top:0}
@media (max-width:760px){.rule-row{grid-template-columns:1fr 1fr}.rule-row .grow{grid-column:1/-1}}
.menu>summary:has(.menu-label){width:auto;padding:0 10px;gap:6px;grid-auto-flow:column;font-size:13px}
@media (max-width:480px){.rule-row{grid-template-columns:1fr}.rule-row button{justify-self:start}}
@media (max-width:640px){
  .table-wrap{background:linear-gradient(to right,var(--card) 30%,transparent) left/32px 100% no-repeat local,linear-gradient(to left,var(--card) 30%,transparent) right/32px 100% no-repeat local,radial-gradient(farthest-side at 0 50%,rgba(0,0,0,.18),transparent) left/10px 100% no-repeat scroll,radial-gradient(farthest-side at 100% 50%,rgba(0,0,0,.18),transparent) right/10px 100% no-repeat scroll}
  .table-wrap table{min-width:520px}
}
@media (max-width:640px){.acc:has(.ops.inline){grid-template-columns:auto minmax(0,1fr) auto}.acc .ops.inline{grid-column:auto}}
@media (max-width:640px){
  .table-wrap table.calls{min-width:0}
  table.calls thead{display:none}
  table.calls tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:12px 24px;border-top:1px solid var(--border)}
  table.calls td{padding:0!important;border:0;text-align:left}
  table.calls td.client{grid-column:1;color:var(--muted)}
  table.calls td.status{grid-column:2;grid-row:1}
  table.calls td.when{grid-column:1/-1}
}
.check-label{display:flex;gap:8px;align-items:baseline}.check-label .dot{flex:none;transform:translateY(-1px)}
.acc .ops form.inline{margin:0;display:inline-flex}
.menu>summary:has(.menu-label){height:32px;color:var(--text)}
@media (max-width:640px){table.calls td.client.empty{display:none}}
.stack-cards{display:flex;flex-direction:column;gap:16px}.stack-cards>.card{margin:0}

/* One account */
.acc-link{color:var(--text);text-decoration:underline;text-decoration-color:var(--border-strong);text-underline-offset:3px;text-decoration-thickness:1px}
.acc-link:hover{color:var(--accent-ink);text-decoration-color:currentColor}
.acc-head-sub{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
.account-grid{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:16px;align-items:start;margin:0 0 16px}
.account-grid>.card,.account-side>.card{margin:0}
.account-side{display:flex;flex-direction:column;gap:16px}
.account-side select{margin-bottom:4px}
.account-side .copy{margin:4px 0 12px}
@media (max-width:1000px){.account-grid{grid-template-columns:1fr}}
.tool-toggles{list-style:none;margin:8px 0 0;padding:0}
.tool-toggles li{border-top:1px solid var(--border)}
.tool-toggle{display:flex;align-items:center;gap:14px;margin:0;padding:12px 24px;font-weight:450;cursor:pointer}
.tool-toggle:hover{background:var(--bg-subtle)}
.tool-toggle .grow{display:flex;flex-direction:column;gap:2px}
.tool-title{font-weight:580;font-size:14.5px}
.form-foot{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding-top:14px;border-top:1px solid var(--border)}
@media (max-width:640px){.tool-toggle{padding:12px 16px;flex-wrap:wrap}.tool-toggle .badge{margin-left:50px}}
input[type=checkbox].switch{appearance:none;-webkit-appearance:none;flex:none;width:36px;height:22px;margin:0;border-radius:99px;background:var(--border-strong);position:relative;cursor:pointer;transition:background .15s}
input[type=checkbox].switch::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:var(--card);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
input[type=checkbox].switch:checked{background:var(--accent)}
input[type=checkbox].switch:checked::after{transform:translateX(14px)}
input[type=checkbox].switch:focus-visible{outline:2px solid var(--accent-ink);outline-offset:2px}
.call-what{display:flex;flex-direction:column;min-width:0}
.call-what>span:first-child{font-weight:540}
.acc-group{padding:14px 20px 6px;font:600 13px/1 ${SANS};color:var(--muted);border-top:1px solid var(--border);background:var(--bg-subtle)}
.acc-group:first-child{border-top:0}
.acc-group+.acc{border-top:0}
a.acc-more{display:block;text-align:center;color:var(--muted);font-size:13.5px;padding:12px 20px;text-decoration:none}
a.acc-more:hover{color:var(--text);background:var(--bg-subtle)}
.attention ul{list-style:none;margin:8px 0 0;padding:0}
.attention li{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:8px 0;border-top:1px solid var(--border)}
.attention li>.grow{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 240px}
.attention li .btn,.attention li form{margin-left:auto}
.notice.attention{background:var(--card);border-color:var(--border);border-left:3px solid var(--warn-border)}
.notice.bad.attention{border-left-color:var(--danger)}
.notice.waiting{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px}
.plan-request{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:flex-start;justify-content:space-between;border-color:var(--accent);background:var(--accent-soft)}
.plan-request p{margin:0;flex:1 1 280px}
.d-block{display:block}
.dot.off{background:var(--border-strong)}
#apps li{align-items:flex-start;gap:16px}
#apps li>.right{max-width:55%}
@media (max-width:640px){#apps li{flex-direction:column;gap:4px}#apps li>.right{max-width:none;text-align:left}}
.page-head .row>form.inline{display:flex}
.dot.warn{background:var(--warn-border)}
/* Failure reasons: plain words first, the service's own message one click away */
.problem-raw{display:inline;margin-left:6px}
.problem-raw summary{display:inline;cursor:pointer;color:var(--muted);font-size:13px;text-decoration:underline;text-underline-offset:3px}
.problem-raw[open]{display:block;margin:6px 0 0}
.problem-raw code{display:block;margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--muted)}
.call-why{color:var(--danger);overflow-wrap:anywhere}
.calls .when .took{display:block;font-size:12px;opacity:.8}
/* Account page: risk, then what the rule makes of it */
.tool-flags{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:none}
.tool-flags .badge svg{width:12px;height:12px}
@media (max-width:640px){.tool-toggle .badge{margin-left:0}.tool-flags{flex-direction:row;flex-wrap:wrap;margin-left:50px;width:100%;align-items:center}}
/* Rules: one header row on wide screens; rows save on change */
.rule-head{display:none}
@media (min-width:761px){.rule-head{display:grid;padding:0 0 4px;border-top:0;font-size:12.5px;font-weight:600;color:var(--muted)}.rule-list .rule-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.rule-row{align-items:center}.rule-head+.rule-row,.rule-head+.acc-group{border-top:1px solid var(--border)}}
.rule-save-slot{display:flex;align-items:center;gap:8px;min-width:70px;justify-content:flex-end}
.js .rule-save{display:none}
select.narrow{max-width:320px}
.reauth-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px}
.reauth-row .small{flex:1 1 220px}
.lock-group{border:0;margin:0;padding:0;min-width:0}
.lock-group:disabled .card{opacity:.6}
.chart{position:relative}
.chart-empty{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);font-size:13.5px}
.error-list>li+li{border-top:1px solid var(--border)}
.error-head{display:flex;gap:12px 16px;justify-content:space-between;align-items:flex-start}
.error-head>div{min-width:0}
.error-message{margin:6px 0 4px;overflow-wrap:anywhere}
.filter-links{gap:8px;margin-bottom:16px}
.filter-links a[aria-current]{border-color:var(--accent);color:var(--accent-ink)}
.jobs-table td{vertical-align:top}
@media (max-width:640px){.error-head{flex-direction:column}}
`;
