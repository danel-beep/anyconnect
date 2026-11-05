import { FONT_FACES, MONO, SANS } from './assets.js';
import { APP_SHELL_CSS } from './styles/app.js';
import { BRAND_CSS } from './styles/brands.js';
import { CONNECT_CSS } from './styles/connect.js';
import { LANDING_CSS } from './styles/landing.js';
import { PROFILES_CSS } from './styles/profiles.js';
import { SITE_CSS } from './styles/site.js';
import { THEMES, themeCss } from './theme.js';

/** QR codes stay dark-on-light in both themes (not every scanner reads inverted codes). */
const QR_COLORS = `background:${THEMES.light.card};color:${THEMES.light.text}`;

/**
 * Base and components: typography, buttons, forms, cards, badges, tables, tabs, meters.
 * Shared by the website, the dashboard, the admin panel and the sign-in / consent pages.
 */
const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation:none!important;transition:none!important}}
body{margin:0;background:var(--bg);color:var(--text);font:400 15px/1.55 ${SANS};letter-spacing:-.003em;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
h1,h2,h3,h4{margin:0 0 .5em;line-height:1.15;letter-spacing:-.022em;font-weight:620}
h1{font-size:26px}
h2{font-size:19px}
h3{font-size:16px}
p{margin:0 0 12px}
a{color:var(--accent-ink);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
a:hover{text-decoration-thickness:2px}
img,svg{max-width:100%}
/* An icon is text-sized unless a rule sizes it: without this an unstyled icon fills its container. */
:where(svg.i){width:1.15em;height:1.15em}
code,kbd,pre,.mono{font-family:${MONO};font-size:.88em;font-variant-ligatures:none}
code{background:var(--code-bg);border:1px solid var(--border);border-radius:6px;padding:.08em .38em;white-space:nowrap}
pre code{border:0;padding:0;background:none;white-space:pre}
pre{margin:0}
hr{border:0;border-top:1px solid var(--border);margin:24px 0}
::selection{background:var(--accent);color:var(--accent-text)}
:focus-visible{outline:2px solid var(--accent-ink);outline-offset:3px;border-radius:6px}
[hidden]{display:none!important}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip{position:absolute;left:12px;top:-60px;z-index:100;background:var(--card);border:1px solid var(--border);padding:8px 12px;border-radius:8px}
.skip:focus{top:12px}
.muted{color:var(--muted)}
.small{font-size:13px}
.tiny{font-size:12px}
.nowrap{white-space:nowrap}
.right{text-align:right}
.num{font-variant-numeric:tabular-nums}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font:500 12px/1 ${MONO};letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 14px}
.eyebrow::before{content:"";width:6px;height:6px;border-radius:2px;background:var(--accent)}
.stack>*+*{margin-top:12px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.row.between{justify-content:space-between}
.grow{flex:1;min-width:0}
.divider{text-align:center;margin:16px 0 0;position:relative}

/* Buttons */
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:0 16px;border-radius:10px;border:1px solid var(--border-strong);background:var(--card);color:var(--text);font:560 14px/1 ${SANS};letter-spacing:-.005em;text-decoration:none;cursor:pointer;transition:background .15s,border-color .15s,box-shadow .15s,transform .05s;white-space:nowrap}
button:hover,.btn:hover{border-color:var(--muted);text-decoration:none}
button:active,.btn:active{transform:translateY(1px)}
button:disabled,.btn[aria-disabled=true]{opacity:.55;cursor:not-allowed;transform:none}
button.primary,.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
button.primary:hover,.btn.primary:hover{background:color-mix(in srgb,var(--accent) 88%,#fff);border-color:var(--accent);box-shadow:0 8px 20px -10px color-mix(in srgb,var(--accent) 85%,transparent)}
button.danger,.btn.danger{color:var(--danger)}
button.danger:hover,.btn.danger:hover{border-color:var(--danger);background:var(--danger-soft)}
button.ghost,.btn.ghost{border-color:transparent;background:transparent}
button.ghost:hover,.btn.ghost:hover{background:var(--bg-subtle)}
button.link{border:0;background:none;padding:0;min-height:0;color:var(--accent-ink);font-weight:500;text-decoration:underline;text-underline-offset:3px}
.btn.lg,button.lg{min-height:48px;padding:0 22px;font-size:15px;border-radius:12px}
.btn.sm,button.sm{min-height:32px;padding:0 12px;font-size:13px;border-radius:8px}
.btn.block,button.block{width:100%}
.btn svg,button svg{width:18px;height:18px;flex:none}
.actions{display:flex;gap:12px;margin-top:20px;flex-wrap:wrap}
.actions>button,.actions>.btn{flex:1}
.actions.start>button,.actions.start>.btn{flex:0 0 auto}
form.inline{display:inline}

/* Forms */
label{display:block;font-weight:560;font-size:14px;margin:16px 0 6px}
input[type=email],input[type=password],input[type=text],input[type=url],input[type=number],input[type=search],input[type=date],select,textarea{width:100%;min-height:42px;padding:9px 12px;border:1px solid var(--border-strong);border-radius:10px;background:var(--card);color:var(--text);font:inherit;transition:border-color .15s,box-shadow .15s}
textarea{min-height:84px;resize:vertical}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
/* Read-only text fields hold codes and links to copy; a read-only email is just shown, quietly. */
input[type=text][readonly]{font-family:${MONO};font-size:13.5px;background:var(--code-bg)}
input[type=email][readonly]{color:var(--muted);border-style:dashed}
input[type=checkbox],input[type=radio]{accent-color:var(--accent);width:16px;height:16px;margin:0 8px 0 0;vertical-align:-3px}
.check{display:flex;align-items:flex-start;gap:8px;font-weight:450;margin:12px 0}
/* The box sits on the middle of the first text line; the gap alone spaces it from the text. */
.check>input[type=checkbox],.check>input[type=radio]{margin:.2em 0 0;flex:none}
.hint{color:var(--muted);font-size:13px;margin:6px 0 0}
.back-link{margin:0 0 12px;font-size:14px}.back-link a{color:var(--muted);text-decoration:none}.back-link a:hover{color:var(--text)}
.hint>svg{width:15px;height:15px;vertical-align:-3px}
.error{color:var(--danger);margin:8px 0 0}
.field-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}
@media (max-width:640px){.field-row{grid-template-columns:1fr}}

/* Surfaces */
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin:0 0 16px}
/* A flush card clips to its rounded corners; something wider (a table on a phone) scrolls inside it. */
.card.flush{padding:0;overflow-x:auto;overflow-y:hidden}
.card.tight{padding:16px 18px}
.card>h2:first-child,.card>h3:first-child{margin-top:0}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 14px;flex-wrap:wrap}
.card-head h2,.card-head h3{margin:0}
/* The head's button stays on the right of the title, also on a phone (the title wraps instead); a note or
   a description simply goes under the title when there is no room. */
.card-head>:last-child:not(:first-child):is(form,button,.btn){margin-left:auto}
@media (max-width:640px){
  .card-head:has(>:last-child:not(:first-child):is(form,button,.btn)){flex-wrap:nowrap;align-items:flex-start}
  .card-head:has(>:last-child:not(:first-child):is(form,button,.btn))>:first-child{min-width:0;flex:1 1 auto}
  .card-head>:last-child:not(:first-child):is(form,button,.btn){flex:none;white-space:nowrap}
}
.panel{background:var(--bg-subtle);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px}
.warning,.notice{background:var(--warn-bg);border:1px solid var(--warn-border);border-radius:10px;padding:10px 14px;margin:12px 0;color:var(--text)}
.notice.info{background:var(--accent-soft);border-color:var(--accent)}
.notice.ok{background:var(--ok-soft);border-color:var(--ok)}
.notice.bad{background:var(--danger-soft);border-color:var(--danger)}
.notice.with-icon{display:flex;gap:10px;align-items:flex-start}
.notice.with-icon>svg{width:17px;height:17px;flex:none;margin-top:2px;color:var(--accent-ink)}
.item{border-top:1px solid var(--border);padding-top:16px;margin-top:16px}
.item:first-of-type{border-top:0;padding-top:0;margin-top:0}

/* Badges, dots */
.badge{display:inline-flex;align-items:center;gap:6px;font:560 12px/1 ${SANS};padding:5px 9px;border-radius:99px;border:1px solid var(--border);color:var(--muted);background:var(--card);white-space:nowrap;vertical-align:1px}
/* A badge right after a name or another badge keeps a little air. */
strong+.badge,.badge+.badge{margin-left:6px}
.badge.ok{color:var(--ok);border-color:transparent;background:var(--ok-soft)}
.badge.bad{color:var(--danger);border-color:transparent;background:var(--danger-soft)}
.badge.accent{color:var(--accent-ink);border-color:transparent;background:var(--accent-soft)}
.badge.warn{color:var(--text);border-color:var(--warn-border);background:var(--warn-bg)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--muted);flex:none}
.dot.ok{background:var(--ok)}
.dot.bad{background:var(--danger)}
.dot.accent{background:var(--accent)}

/* Lists, tables */
ul.plain,ol.plain{list-style:none;padding:0;margin:0}
ul.plain>li,ol.plain>li{padding:12px 0;border-top:1px solid var(--border);display:flex;justify-content:space-between;gap:12px;align-items:center}
ul.plain>li:first-child,ol.plain>li:first-child{border-top:0}
/* On a phone a row of label and quiet text value (not a button) puts the value on its own line,
   the same in every row of the list, so long labels are not squeezed into one word per line. */
@media (max-width:640px){:is(ul,ol).plain>li:has(>.muted:last-child:not(:first-child)){flex-wrap:wrap;gap:2px 12px}:is(ul,ol).plain>li:has(>.muted:last-child:not(:first-child))>:first-child{flex:1 1 100%}}
ul.bullets{margin:4px 0 12px;padding-left:20px}
ul.bullets li+li{margin-top:4px}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:10px 12px;border-top:1px solid var(--border);vertical-align:middle}
th{color:var(--muted);font-weight:560;font-size:12.5px;border-top:0;background:var(--bg-subtle);white-space:nowrap}
.card.flush table th:first-child,.card.flush table td:first-child{padding-left:24px}
.card.flush table th:last-child,.card.flush table td:last-child{padding-right:24px}
tbody tr:hover td{background:var(--bg-subtle)}
table.kv th{background:none;width:38%;font-size:13px;vertical-align:top}
table.kv td,table.kv th{padding:8px 0}
table.kv th{padding-right:16px}
pre.args,pre.block{background:var(--code-bg);border:1px solid var(--border);border-radius:10px;padding:12px 14px;font-size:13px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}

/* Copy field */
.copy{display:flex;gap:8px;align-items:stretch}
.copy input{flex:1;min-width:0}
.copy button{flex:none}
[data-copied] .copy-label{display:none}
.copy-done{display:none}
[data-copied] .copy-done{display:inline}

/* Tabs (progressive: without JS every panel is shown with its title) */
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);overflow-x:auto;scrollbar-width:none;margin:0 0 18px}
.tabs::-webkit-scrollbar{display:none}
/* On narrow screens the tab row scrolls: its fading edge says there is more to the right */
@media (max-width:640px){.tabs{mask-image:linear-gradient(to right,#000 82%,transparent);-webkit-mask-image:linear-gradient(to right,#000 82%,transparent);padding-right:24px}}
.tab{appearance:none;border:0;background:none;border-radius:0;min-height:40px;padding:0 12px;color:var(--muted);font-weight:560;border-bottom:2px solid transparent;margin-bottom:-1px}
.tab:hover{color:var(--text);border-color:transparent}
.tab[aria-selected=true]{color:var(--text);border-bottom-color:var(--accent)}
.js .tab-panel[data-inactive]{display:none}
.tabs-nojs-title{display:none}
html:not(.js) .tabs{display:none}
html:not(.js) .tabs-nojs-title{display:block;margin-top:20px}

/* Meter */
.meter{height:8px;border-radius:99px;background:var(--bg-subtle);border:1px solid var(--border);overflow:hidden}
.meter+p{margin-top:16px}
.meter>span{display:block;height:100%;background:var(--accent);border-radius:99px;min-width:2px}
.meter.ok>span{background:var(--ok)}
.meter.bad>span{background:var(--danger)}
.w-0{width:0}.w-5{width:5%}.w-10{width:10%}.w-15{width:15%}.w-20{width:20%}.w-25{width:25%}.w-30{width:30%}.w-35{width:35%}.w-40{width:40%}.w-45{width:45%}.w-50{width:50%}.w-55{width:55%}.w-60{width:60%}.w-65{width:65%}.w-70{width:70%}.w-75{width:75%}.w-80{width:80%}.w-85{width:85%}.w-90{width:90%}.w-95{width:95%}.w-100{width:100%}
.h-0{height:2%}.h-5{height:5%}.h-10{height:10%}.h-15{height:15%}.h-20{height:20%}.h-25{height:25%}.h-30{height:30%}.h-35{height:35%}.h-40{height:40%}.h-45{height:45%}.h-50{height:50%}.h-55{height:55%}.h-60{height:60%}.h-65{height:65%}.h-70{height:70%}.h-75{height:75%}.h-80{height:80%}.h-85{height:85%}.h-90{height:90%}.h-95{height:95%}.h-100{height:100%}

/* Service logos */
.logo-tile{display:inline-grid;place-items:center;width:40px;height:40px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);flex:none}
.logo-tile svg{width:20px;height:20px}
.logo-tile svg:not([fill=none]){fill:currentColor}
.logo-tile.sm{width:32px;height:32px;border-radius:8px}
.logo-tile.sm svg{width:16px;height:16px}
.logo-tile.lg{width:56px;height:56px;border-radius:14px}
.logo-tile.lg svg{width:28px;height:28px}
.logo-tile .mono-letter{font:650 15px/1 ${MONO}}

/* Details / FAQ */
details{border-top:1px solid var(--border)}
details:last-of-type{border-bottom:1px solid var(--border)}
summary{list-style:none;cursor:pointer;padding:18px 36px 18px 0;font-weight:580;font-size:16px;position:relative}
summary::-webkit-details-marker{display:none}
summary::after{content:"";position:absolute;right:6px;top:50%;width:10px;height:10px;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:translateY(-70%) rotate(45deg);transition:transform .2s}
details[open] summary::after{transform:translateY(-30%) rotate(-135deg)}
details>div{padding:0 0 18px;color:var(--muted);max-width:760px}

/* Legacy layout helpers (sign-in, consent, confirmation pages) */
header.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:12px;flex-wrap:wrap}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:700;font-size:17px;letter-spacing:-.02em;color:var(--text);text-decoration:none}
.brand:hover{text-decoration:none}
.brand-mark{width:26px;height:26px;flex:none}
.bm-bg{fill:var(--accent)}
.bm-fg{stroke:var(--accent-text)}
.bm-dot{fill:var(--accent-text)}
.qr{display:block;width:200px;height:200px;margin:8px 0 12px;border-radius:8px;${QR_COLORS}}
ul.codes{list-style:none;padding:0;margin:12px 0 16px;display:grid;grid-template-columns:repeat(2,1fr);gap:6px 16px}
ul.codes code{font-size:15px}
/* Vault: the code two browsers compare, and the one-time recovery key */
main.content>.vault-banner{margin-bottom:16px}
code.device-code{font-size:18px;letter-spacing:.08em;padding:2px 8px}
code.recovery-key{display:block;font-size:15px;line-height:1.7;padding:10px 12px;overflow-wrap:anywhere;user-select:all}

/* Auth pages: centered card */
/* Sign-in style windows: one screen, the card centred between a slim top bar and footer */
.auth{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column}
.auth-top{display:flex;justify-content:space-between;align-items:center;padding:14px 24px}
.auth main{flex:1;width:100%;max-width:440px;margin:0 auto;padding:8px 16px 16px;display:flex;flex-direction:column;justify-content:center}
.auth main.wide{max-width:760px}
.auth .card{padding:26px 28px}
.auth h1{font-size:24px}
.auth-foot{text-align:center;padding:12px 16px 16px;color:var(--muted);font-size:13px}
.consent h1{margin-bottom:10px}
.consent-who{margin:0 0 4px}
.consent-can{font-weight:600;margin:14px 0 6px}
.consent-list{margin:0 0 14px}
.consent-list li{margin:2px 0}
details.consent-as{border:1px solid var(--border);border-radius:10px;padding:0 12px;margin:0 0 4px;font-size:13.5px}
details.consent-as>summary{padding:9px 24px 9px 0;font-size:inherit;font-weight:400;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
details.consent-as>summary strong{color:var(--text);font-weight:560}
details.consent-as[open]{padding-bottom:10px}
details.consent-as select{margin-top:2px}
details.consent-as p{margin:6px 0 0}
.consent .warning{padding:8px 12px;margin:8px 0 0}
.consent-foot{margin:10px 0 0}
@media (max-width:480px){.auth-top{padding:12px 16px}.auth main{padding:4px 12px 12px}.auth .card{padding:22px 20px}.auth h1{font-size:22px}}
@media (max-height:740px){.auth-top{padding-top:10px;padding-bottom:10px}.auth .card{padding-top:18px;padding-bottom:18px}.auth-foot{padding:6px 16px 10px}.consent-can{margin-top:10px}.consent-list{margin-bottom:10px}}
.auth-foot a{color:var(--muted)}
.btn-google{background:var(--card);border-color:var(--border-strong);color:var(--text);min-height:46px;font-size:15px}
.btn-google svg{width:18px;height:18px}
.btn-google.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
.btn-google.primary svg{background:#fff;border-radius:50%;padding:3px;width:24px;height:24px}
.or{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:13px;margin:18px 0}
.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--border)}

/* Toggles in the header */
.prefs{display:flex;align-items:center;gap:4px}
.icon-btn{display:inline-grid;place-items:center;width:36px;height:36px;min-height:36px;padding:0;border-radius:9px;border:1px solid transparent;background:transparent;color:var(--muted)}
.icon-btn:hover{color:var(--text);background:var(--bg-subtle);border-color:var(--border)}
.icon-btn svg{width:18px;height:18px}
.lang-link{font:560 12px/1 ${MONO};color:var(--muted);text-decoration:none;padding:8px;border-radius:8px}
.lang-link:hover{color:var(--text);background:var(--bg-subtle);text-decoration:none}
.theme-dark-icon{display:none}
:root[data-theme=dark] .theme-dark-icon{display:block}
:root[data-theme=dark] .theme-light-icon{display:none}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .theme-dark-icon{display:block}:root:not([data-theme=light]) .theme-light-icon{display:none}}
.connect-advanced{margin:8px 0 16px;border:1px solid var(--border);border-radius:12px;padding:0 14px}
.connect-advanced>summary{padding:12px 0;font-weight:560;cursor:pointer}
.connect-advanced>section{padding:4px 0 8px}
`;

/** Served at /assets/app.css (no inline styles, so the CSP can forbid them). Colors come from `theme.ts`. */
export const APP_CSS = [
  FONT_FACES,
  themeCss(),
  BASE_CSS,
  SITE_CSS,
  LANDING_CSS,
  APP_SHELL_CSS,
  CONNECT_CSS,
  PROFILES_CSS,
  BRAND_CSS,
].join('\n');
