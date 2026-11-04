import { MONO } from '../assets.js';

/** The signed-in area (dashboard and admin panel): sidebar, page header, stats, lists. */
export const APP_SHELL_CSS = `
.shell{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh;background:linear-gradient(to right,var(--bg-subtle) 247px,var(--border) 247px,var(--border) 248px,transparent 248px)}
.sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:4px;padding:18px 14px;border-right:1px solid var(--border);background:var(--bg-subtle);overflow-y:auto}
.sidebar .brand{padding:6px 8px 18px}
.side-group{font:500 11px/1 ${MONO};letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:18px 10px 8px}
.side-link{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;color:var(--muted);text-decoration:none;font-weight:540;font-size:14px}
.side-link svg{width:17px;height:17px;flex:none}
.side-link:hover{color:var(--text);background:var(--card);text-decoration:none}
.side-link[aria-current=page]{color:var(--text);background:var(--card);box-shadow:inset 0 0 0 1px var(--border)}
.side-link .count{margin-left:auto;font:600 11px/1 ${MONO};background:var(--accent);color:var(--accent-text);border-radius:99px;padding:4px 7px}
.side-foot{margin-top:auto;padding-top:16px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:10px}
.who{display:flex;align-items:center;gap:10px;padding:4px 6px;min-width:0}
.avatar{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent-ink);font-weight:650;font-size:13px;flex:none;text-transform:uppercase}
.who .grow{overflow:hidden}
.who .email{font-size:13px;font-weight:560;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.who .plan-name{font-size:12px;color:var(--muted);display:block}
.side-tools{display:flex;align-items:center;gap:4px;padding:0 2px}
.side-tools .prefs{margin-right:auto}
.side-tools form.inline{display:flex}
.content{min-width:0;padding:28px 40px 72px;max-width:1120px;width:100%}
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
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:0 0 16px}
.stat{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;min-width:0}
.stat .label{font-size:13px;color:var(--muted);display:flex;align-items:center;justify-content:space-between;gap:8px}
.stat .value{font-size:26px;font-weight:640;letter-spacing:-.03em;margin:6px 0 2px;font-variant-numeric:tabular-nums}
.stat .sub{font-size:12.5px;color:var(--muted)}
.stat .meter{margin-top:10px}
@media (max-width:1000px){.stats{grid-template-columns:1fr 1fr}}
@media (max-width:520px){.stats{grid-template-columns:1fr 1fr}}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
@media (max-width:1000px){.grid-2,.grid-3{grid-template-columns:1fr}}
.grid-2>.card,.grid-3>.card{margin:0}
.grid-2,.grid-3{margin-bottom:16px}

/* Onboarding */
.onboard{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:0 0 16px}
.onboard-step{border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;background:var(--card);display:flex;gap:12px;align-items:flex-start;color:var(--text);text-decoration:none}
a.onboard-step:hover{border-color:var(--border-strong);text-decoration:none}
.onboard-step .tick{width:24px;height:24px;border-radius:50%;border:1.5px solid var(--border-strong);display:grid;place-items:center;flex:none;font:600 12px/1 ${MONO};color:var(--muted)}
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
@media (max-width:640px){.acc{grid-template-columns:auto minmax(0,1fr)}.acc .ops{grid-column:1/-1;justify-content:flex-start}}

/* Catalog in the dashboard */
.catalog{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
.cat-item{display:flex;gap:12px;align-items:flex-start;padding:14px;border:1px solid var(--border);border-radius:12px;background:var(--card)}
.cat-item .grow p{margin:2px 0 8px;font-size:13px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cat-item strong{font-size:14.5px}

/* Activity chart */
.chart{display:flex;align-items:flex-end;gap:3px;height:120px;padding:8px 0 0;border-bottom:1px solid var(--border)}
.chart .col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;min-width:3px}
.chart .col span{display:block;background:var(--accent);border-radius:3px 3px 0 0;min-height:2px}
.chart .col.zero span{background:var(--border)}
.chart-axis{display:flex;justify-content:space-between;font:500 11px/1 ${MONO};color:var(--muted);padding-top:8px}
.top-list{display:flex;flex-direction:column;gap:10px}
.top-list .bar{display:grid;grid-template-columns:minmax(0,1fr) 120px auto;gap:12px;align-items:center;font-size:13.5px}
.top-list .bar .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Plan cards in the dashboard */
.plan-mini{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.plan-mini .plan{padding:18px;gap:10px}
.plan-mini .price .amount{font-size:28px}
.plan.current{border-color:var(--ok);box-shadow:0 0 0 1px var(--ok)}
@media (max-width:1100px){.plan-mini{grid-template-columns:1fr 1fr}}
@media (max-width:560px){.plan-mini{grid-template-columns:1fr}}

/* Danger zone */
.danger-zone{border-color:var(--danger)}
.danger-zone h2{color:var(--danger)}

.pad-x{padding:0 20px 16px;margin:0}
ul.plain.pad-x{padding:0 20px 6px}
.wide-2{grid-column:span 2}
@media (max-width:640px){.wide-2{grid-column:auto}}
.search-sm{max-width:260px;min-height:36px!important;padding:6px 12px!important}
.tiny-badge{margin-left:6px;padding:3px 7px}
.guide-compact pre.block{white-space:pre;overflow-x:auto;margin-top:8px}
.guide-compact ol{margin-top:0}

/* Admin */
.admin-tag{font:600 10.5px/1 ${MONO};letter-spacing:.06em;text-transform:uppercase;background:var(--text);color:var(--bg);border-radius:5px;padding:4px 6px;margin-left:6px}
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
.rule-row{display:grid;grid-template-columns:minmax(0,1fr) 200px 200px auto;gap:12px;align-items:end;padding:12px 0;border-top:1px solid var(--border)}
.rule-row:first-child{border-top:0}
.rule-row label{margin:0 0 4px;display:block}
@media (max-width:760px){.rule-row{grid-template-columns:1fr 1fr}.rule-row .grow{grid-column:1/-1}}
`;
