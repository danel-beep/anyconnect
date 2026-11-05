import { MONO, SANS } from '../assets.js';

/**
 * The landing page (`src/web/landing.tsx`). Motion rules:
 * - every element's own styles are its final state, so with reduced motion (the base CSS turns all
 *   animations off) or without JavaScript the page is complete and still;
 * - hidden "before" states exist only under `.reveal` (added by site.js) and
 *   `prefers-reduced-motion: no-preference`;
 * - `[data-reveal]` rises in once when scrolled into view, `[data-reveal=kids]` does it for each
 *   child in turn, `[data-reveal=play]` only holds its inner animations until it is on screen, and
 *   `[data-live]` loops only while visible.
 * Only opacity, transform and SVG stroke offsets are animated, so nothing shifts the layout.
 */

/** Light text on the graphite band (`.section.ink`), the same in both themes. */
const INK_TEXT = '#f5f5f4';
const INK_MUTED = '#b9b9bf';
const INK_LINE = 'rgba(255,255,255,.14)';

const STAGGER = Array.from(
  { length: 18 },
  (_, i) =>
    `[data-reveal=kids].in>:nth-child(${i + 2}){animation-delay:${Math.min((i + 1) * 0.06, 0.6).toFixed(2)}s}`,
).join('');

export const LANDING_CSS = `
.section[id]{scroll-margin-top:72px}
.section.subtle{background:var(--bg-subtle)}

/* Hero */
.hero{padding:64px 0 40px;position:relative;isolation:isolate;overflow-x:clip}
@supports not (overflow:clip){.hero{overflow:hidden}}
.hero::before{content:"";position:absolute;z-index:-1;pointer-events:none;width:760px;height:760px;right:-180px;top:-200px;background:radial-gradient(closest-side,color-mix(in srgb,var(--accent) 17%,transparent),transparent);-webkit-mask-image:linear-gradient(transparent 200px,#000 420px);mask-image:linear-gradient(transparent 200px,#000 420px)}
.hero::after{content:"";position:absolute;z-index:-2;inset:0;pointer-events:none;background-image:radial-gradient(color-mix(in srgb,var(--text) 13%,transparent) 1px,transparent 1.4px);background-size:22px 22px;-webkit-mask-image:radial-gradient(ellipse 55% 52% at 74% 36%,#000,transparent 70%);mask-image:radial-gradient(ellipse 55% 52% at 74% 36%,#000,transparent 70%)}
.hero .wrap{display:grid;grid-template-columns:minmax(0,1.04fr) minmax(0,1fr);gap:56px;align-items:center}
.hero .eyebrow{margin-bottom:18px}
.hero h1{font-size:clamp(40px,5.3vw,64px);line-height:1.03;letter-spacing:-.045em;font-weight:660;margin:0 0 22px}
.hero h1 .mark{display:block;color:var(--accent-ink)}
.hero .lead{max-width:560px;margin:0 0 28px}
.hero-actions .btn .i{transition:transform .2s}
.hero-actions .btn:hover .i:last-child{transform:translateX(3px)}
.hero-note{list-style:none;padding:0;margin:20px 0 0;color:var(--muted);font-size:13px;display:flex;gap:6px 18px;flex-wrap:wrap}
.hero-note li{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.hero-note svg{width:14px;height:14px;color:var(--ok);stroke-width:2.4}
.hero-note a{color:inherit;text-underline-offset:3px;text-decoration-color:color-mix(in srgb,currentColor 45%,transparent)}
.hero-note a:hover{color:var(--text)}
@media (max-width:960px){.hero .wrap{grid-template-columns:1fr;gap:44px}.hero{padding:36px 0 32px}}
@media (max-width:520px){.hero-actions{flex-direction:column;align-items:stretch}.hero-actions .btn{width:100%}}

/* Hero chat */
.demo{position:relative;background:var(--card);border:1px solid var(--border);border-radius:18px;box-shadow:0 1px 0 rgba(0,0,0,.03),0 30px 70px -32px rgba(0,0,0,.38);overflow:hidden;font-size:14px}
.demo-bar{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border);font:600 14px/1.2 ${SANS};color:var(--text)}
.demo-avatar{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:#d97757;color:#fff;flex:none}
.demo-avatar svg{width:15px;height:15px;fill:currentColor}
.demo-status{display:inline-flex;align-items:center;gap:6px;font-weight:500;font-size:12px;color:var(--muted);padding:5px 9px;border-radius:999px;background:var(--bg-subtle)}
.demo-body{padding:18px 20px 16px;display:flex;flex-direction:column;gap:10px}
.demo .msg{max-width:88%;padding:10px 14px;border-radius:14px;line-height:1.5;text-wrap:pretty}
.demo .msg.user{align-self:flex-end;background:var(--bg-subtle);border:1px solid var(--border);border-bottom-right-radius:4px}
.demo .msg.ai{align-self:stretch;max-width:none;padding:2px 0 0;position:relative}
.call{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px 12px;border:1px solid var(--border);border-radius:10px;font:450 12.5px/1.4 ${MONO};background:var(--code-bg)}
.call>svg{width:14px;height:14px;color:var(--ok);stroke-width:2.6}
.call b{font-weight:600;color:var(--text)}
.call .args{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.call .res{color:var(--ok);white-space:nowrap;display:inline-flex;align-items:center;gap:8px}
.call .tags{display:inline-flex;gap:4px}
.call .tags i{font-style:normal;font-size:11px;line-height:1;padding:3px 6px;border-radius:5px;border:1px solid var(--border-strong);color:var(--muted);background:var(--card)}
.approve{border:1px solid color-mix(in srgb,var(--accent) 60%,var(--border));border-radius:12px;padding:12px 14px;background:var(--accent-soft)}
.approve .who{display:flex;align-items:center;gap:8px;font-weight:600;font-size:12.5px;color:var(--accent-ink)}
.approve .who .brand-mark{width:18px;height:18px}
.approve p{margin:6px 0 10px;font-size:13.5px;line-height:1.45}
.approve .decide{display:grid}
.approve .decide>*{grid-area:1/1}
.approve .btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;opacity:0;visibility:hidden}
.approve .btns span{text-align:center;padding:7px;border-radius:8px;border:1px solid var(--border-strong);background:var(--card);font-weight:560;font-size:13px}
.approve .btns .yes{border-color:var(--accent);background:var(--accent);color:var(--accent-text)}
.approve .approved{display:flex;align-items:center;justify-content:center;gap:6px;border-radius:8px;background:var(--ok-soft);color:var(--ok);font-weight:600;font-size:13px}
.approve .approved svg{width:15px;height:15px;stroke-width:2.6}
.demo .typing{position:absolute;left:0;top:8px;width:30px;height:8px;opacity:0;background:radial-gradient(circle,var(--muted) 3px,transparent 3.6px) 0 0/10px 8px repeat-x}
.demo-replay{display:none;width:30px;height:30px;min-height:0;padding:0;border:0;background:transparent;color:var(--muted);border-radius:8px}
.demo-replay:hover{color:var(--text);background:var(--bg-subtle)}
.demo-replay svg{width:15px;height:15px}
.step-guides{display:inline-flex;align-items:center;gap:6px;margin-top:16px;font-size:14px;font-weight:560;color:var(--accent-ink);text-decoration:none}
.step-guides:hover{text-decoration:underline}
.step-guides svg{width:14px;height:14px}
.demo-input{display:flex;align-items:center;gap:10px;margin:0 16px 16px;padding:12px 14px;border:1px solid var(--border);border-radius:14px;color:var(--muted);font-size:14px;opacity:.6;user-select:none}
.demo-input svg{width:16px;height:16px;flex:none}
/* Where the chat card is narrow (two-column hero on small laptops, phones), results go under their call */
@media (min-width:961px) and (max-width:1180px){.call{grid-template-columns:auto minmax(0,1fr)}.call .res{grid-column:2}}
@media (max-width:520px){.demo-body{padding:16px 14px}.call{grid-template-columns:auto minmax(0,1fr)}.call .res{grid-column:2}}

/* Works with */
.works{padding:28px 0 64px}
.works .wrap{display:flex;flex-direction:column;align-items:center;gap:16px}
.works p{margin:0;font-size:14px;line-height:1.4;color:var(--muted);text-align:center}
.works ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;justify-content:center;gap:8px 10px}
.works a{display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 15px 0 12px;border-radius:999px;border:1px solid var(--border);background:var(--card);color:var(--text);text-decoration:none;font-weight:540;font-size:14px;white-space:nowrap;transition:border-color .15s,transform .15s}
.works a:hover{border-color:var(--accent);transform:translateY(-1px)}
.works a svg{width:16px;height:16px;flex:none;color:var(--muted)}
.works a svg:not([fill=none]){fill:currentColor}
@media (max-width:640px){
  .works{padding-bottom:48px}
  .works ul{gap:8px}
  .works a{height:36px;padding:0 13px 0 11px;font-size:13.5px}
}

/* Graphite band: the hub diagram */
.section.ink{background:var(--ink-surface);color:${INK_TEXT};position:relative;overflow:hidden;isolation:isolate;border-block:1px solid ${INK_LINE}}
.section.ink :focus-visible{outline-color:#ff9a5c}
.section.ink .section-head{margin-bottom:56px}
.section.ink .section-head p:not(.eyebrow),.section.ink .eyebrow{color:${INK_MUTED}}
/* Symmetric: equal side columns around a fixed-width hub, the same number of rows on each side */
.hubmap{--map-h:320px;--wire-w:150px;position:relative;display:grid;grid-template-columns:minmax(0,1fr) var(--wire-w) 216px var(--wire-w) minmax(0,1fr);height:var(--map-h)}
.hubmap::before{content:"";position:absolute;z-index:-1;left:50%;top:50%;width:720px;height:520px;margin:-260px 0 0 -360px;pointer-events:none;background:radial-gradient(closest-side,color-mix(in srgb,var(--accent) 15%,transparent),transparent)}
.hubmap-col{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.hubmap-col li{flex:1;display:flex;align-items:center;min-width:0}
.hubmap .node{width:100%;display:flex;align-items:center;gap:10px;height:46px;padding:0 14px;border:1px solid ${INK_LINE};border-radius:12px;background:rgba(255,255,255,.045);font-weight:540;color:${INK_TEXT};white-space:nowrap;min-width:0}
.hubmap .node svg{width:18px;height:18px;flex:none}
.hubmap .node svg:not([fill=none]){fill:currentColor}
.map-accs{margin-left:auto;display:flex;gap:4px;min-width:0;overflow:hidden}
.map-acc{display:inline-flex;font:500 11px/1 ${MONO};color:${INK_MUTED};border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:4px 7px}
.wires{display:block;width:var(--wire-w);height:var(--map-h);overflow:visible}
.wire{fill:none;stroke:rgba(255,255,255,.24);stroke-width:1.5}
.port{fill:var(--accent)}
.pulse{fill:none;stroke:var(--accent);stroke-width:2.6;stroke-linecap:round;stroke-dasharray:22 300;stroke-dashoffset:22;opacity:0}
.hub-core{position:relative;align-self:center;display:flex;flex-direction:column;align-items:center;gap:8px;padding:24px 20px;border-radius:18px;text-align:center;background:color-mix(in srgb,var(--accent) 9%,#262629);border:1px solid color-mix(in srgb,var(--accent) 60%,transparent);box-shadow:0 0 0 6px color-mix(in srgb,var(--accent) 9%,transparent),0 24px 60px -18px color-mix(in srgb,var(--accent) 50%,transparent)}
.core-glow{position:absolute;inset:-1px;border-radius:inherit;pointer-events:none;box-shadow:0 0 0 12px color-mix(in srgb,var(--accent) 6%,transparent),0 24px 70px -10px color-mix(in srgb,var(--accent) 60%,transparent);opacity:0}
.hub-core .brand-mark{width:42px;height:42px}
.hub-core strong{font-size:18px;letter-spacing:-.02em}
.hub-core .mono{font-size:12px;color:${INK_MUTED}}
.versus{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:64px}
.vs-card{border:1px solid ${INK_LINE};border-radius:14px;padding:22px 24px;background:rgba(255,255,255,.03)}
.vs-card h3{display:flex;align-items:center;gap:8px;font-size:15px;margin:0 0 12px;color:${INK_MUTED};font-weight:600}
.vs-card h3 svg{width:18px;height:18px;stroke-width:2.2}
.vs-card .vs-stat{font-size:17px;font-weight:620;letter-spacing:-.01em;font-variant-numeric:tabular-nums;color:${INK_TEXT};margin:0 0 6px}
.vs-card p{color:${INK_MUTED};margin:0;font-size:14.5px}
.vs-card.after{border-color:color-mix(in srgb,var(--accent) 55%,transparent);background:color-mix(in srgb,var(--accent) 8%,transparent)}
.vs-card.after h3{color:${INK_TEXT}}
.vs-card.after h3 svg{color:var(--accent)}
.map-compare{margin:22px 0 0}
.section.ink .map-compare a{color:#ffad74;font-weight:540;text-decoration:none}
.map-compare a span{text-decoration:underline;text-underline-offset:3px}
.map-compare a:hover span{text-decoration-thickness:2px}
.map-compare svg{width:16px;height:16px;vertical-align:-3px;margin-left:6px}
@media (max-width:960px){
  .hubmap{display:flex;flex-direction:column;height:auto}
  .wires{display:none}
  .hubmap-col{gap:8px}
  .hubmap::before{display:none}
  .hubmap-col{width:100%;max-width:560px;margin:0 auto}
  .hubmap-col.clients{flex-direction:row;flex-wrap:wrap;justify-content:center}
  .hubmap-col.clients{max-width:720px}
  .hubmap-col.clients::after,.hubmap-col.services::before{content:"";align-self:center;height:0;border-top:2px solid rgba(255,255,255,.24)}
  /* 64% wide plus 18% margins on each side fills the line, so the rail always starts a row of its own */
  .hubmap-col.clients::after{flex:0 0 64%;margin:12px 18% 0}
  .hubmap-col.services::before{flex:none;width:64%;margin-bottom:12px}
  .hubmap-col.clients li{flex:none}
  .hubmap-col.clients .node{width:auto;height:40px;border-radius:999px}
  .hubmap-col.services .node{height:42px}
  .hub-core{position:relative;margin:36px auto}
  .hub-core::before,.hub-core::after{content:"";position:absolute;left:50%;width:2px;height:36px;margin-left:-1px;background:rgba(255,255,255,.24)}
  .hub-core::before{bottom:100%}
  .hub-core::after{top:100%}
  .versus{grid-template-columns:1fr;margin-top:40px}
}

/* Steps */
.steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.step-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px;display:flex;flex-direction:column;gap:12px}
.step-card .n{font:600 12px/1 ${MONO};color:var(--accent-ink);background:var(--accent-soft);border-radius:6px;padding:6px 8px;align-self:flex-start}
.step-card h3{font-size:18px;margin:4px 0 0}
.step-card p{color:var(--muted);margin:0}
.step-card .visual{margin-top:auto;padding-top:8px}
.visual.stack{display:flex;flex-direction:column;gap:8px}
.signed{display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--bg-subtle);font-size:14px}
.signed svg{width:16px;height:16px;color:var(--ok);stroke-width:2.4}
.url-pill{display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px dashed var(--border-strong);border-radius:10px;font:500 13px/1 ${MONO};background:var(--code-bg);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.prompt-pill{padding:10px 12px;border-radius:12px;background:var(--bg-subtle);border:1px solid var(--border);font-size:14px}
.steps-cta{display:flex;align-items:center;justify-content:flex-start;gap:12px 18px;flex-wrap:wrap;margin-top:40px;font-size:14px}
@media (max-width:860px){.steps{grid-template-columns:1fr}}
@media (max-width:520px){.steps-cta{flex-direction:column}.steps-cta .btn{width:100%}}

/* Features */
.bento{display:grid;grid-template-columns:repeat(6,1fr);gap:16px}
.tile{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:26px;display:flex;flex-direction:column;gap:10px;overflow:hidden}
.tile h3{font-size:19px;margin:0;letter-spacing:-.02em}
.tile p{color:var(--muted);margin:0}
.tile .visual{padding-top:12px}
.tile.c2{grid-column:span 2}.tile.c3{grid-column:span 3}.tile.c4{grid-column:span 4}
@media (min-width:641px) and (max-width:960px){.bento{grid-template-columns:1fr 1fr}.tile.c2,.tile.c3{grid-column:span 1}.tile.c4,.tile:last-child:nth-child(even){grid-column:span 2}}
@media (max-width:640px){.bento{grid-template-columns:minmax(0,1fr)}.tile.c2,.tile.c3,.tile.c4{grid-column:auto}}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:6px;font:500 12px/1 ${MONO};padding:7px 9px;border:1px solid var(--border);border-radius:8px;background:var(--bg-subtle);color:var(--text);transition:background .4s,border-color .4s,color .4s}
.chip svg{width:13px;height:13px}
.chip svg:not([fill=none]){fill:currentColor}
.chip.on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-ink)}
.codebox{background:var(--code-bg);border:1px solid var(--border);border-radius:10px;padding:12px 14px;font:450 12.5px/1.6 ${MONO};white-space:pre-wrap;overflow-wrap:anywhere;color:var(--muted)}
.codebox b{color:var(--text);font-weight:600}
.codebox i{font-style:normal;color:var(--accent-ink)}
.codebox .res{white-space:nowrap}
.rules{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.rules li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px 8px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg-subtle);font-size:13.5px}
.rules .lvl{flex:none;font-size:12px;font-weight:600;padding:4px 8px;border-radius:999px;background:var(--ok-soft);color:var(--ok)}
.rules .r-ask .lvl{background:var(--accent-soft);color:var(--accent-ink)}
.rules .r-block .lvl{background:var(--danger-soft);color:var(--danger)}
.mini-chat{display:flex;flex-direction:column;gap:8px}
.bubble{max-width:90%;padding:9px 12px;border-radius:12px;font-size:13.5px;line-height:1.45}
.bubble.me{align-self:flex-end;background:var(--bg-subtle);border:1px solid var(--border);border-bottom-right-radius:4px}
.bubble.ai{align-self:flex-start;background:var(--accent-soft);border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);border-bottom-left-radius:4px}
.routes{display:flex;flex-direction:column;gap:8px}
.route{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg-subtle);font:450 12.5px/1.3 ${MONO}}
.route code{font-size:12px;background:var(--card);color:var(--accent-ink);border-color:color-mix(in srgb,var(--accent) 40%,var(--border))}
.route svg{width:14px;height:14px;color:var(--muted)}
.route .rule{margin-left:auto;font:500 12px/1 ${SANS};color:var(--muted)}
@media (max-width:900px){.route{display:grid;grid-template-columns:auto minmax(0,1fr);row-gap:8px}.route svg{display:none}.route .rule{grid-column:1/-1;margin-left:0}}
.codebox.results{display:grid;grid-template-columns:minmax(0,1fr);gap:2px}
.codebox.results .row{display:flex;justify-content:space-between;gap:12px}
.codebox.results .res{color:var(--ok)}
.own-servers{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:minmax(0,1fr);gap:8px}
.own-server{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--code-bg);font:450 12.5px/1.3 ${MONO}}
.own-server .kind{font:600 11px/1 ${MONO};letter-spacing:.04em;color:var(--accent-ink);border:1px solid color-mix(in srgb,var(--accent) 40%,var(--border));background:var(--card);border-radius:6px;padding:4px 6px;min-width:42px;text-align:center}
@media (max-width:480px){.own-server .ok-pill{padding:6px}.own-server .ok-pill .word{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}}
.own-server .url{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
.ok-pill{display:inline-flex;align-items:center;gap:6px;font:500 12px/1 ${SANS};color:var(--ok);background:var(--ok-soft);border-radius:999px;padding:5px 9px}
.bars{display:flex;flex-direction:column;gap:10px;font-size:13px}
.bars-label{font:500 11px/1.4 ${MONO};letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.bar{display:grid;grid-template-columns:78px minmax(0,1fr) 84px;gap:10px;align-items:center}
.bar .tiny{text-align:right}
.track{height:8px;border-radius:99px;background:var(--bg-subtle);border:1px solid var(--border);overflow:hidden}
.fill{display:block;height:100%;border-radius:99px;transform-origin:left;transition:transform 1.1s cubic-bezier(.2,.7,.2,1) .5s}
.bar.all .fill{width:100%;background:color-mix(in srgb,var(--danger) 70%,var(--card))}
.bar.ours .fill{width:6%;min-width:8px;background:var(--ok)}

/* Services */
.logo-grid{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}
.logo-grid a{display:flex;align-items:center;gap:10px;height:100%;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--card);color:var(--text);text-decoration:none;font-weight:540;font-size:14px;transition:border-color .15s,transform .15s}
.logo-grid a:hover{border-color:var(--accent);transform:translateY(-2px)}
.logo-grid a>span:last-child{min-width:0;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-height:1.25}
.logo-grid .logo-tile{width:34px;height:34px;border-radius:9px}
.logo-grid .logo-tile svg{width:18px;height:18px}
.logo-grid .more a{border-style:dashed;color:var(--accent-ink);font-weight:600}
.logo-grid .more .logo-tile{color:var(--accent-ink);background:var(--accent-soft);border-color:transparent}
.logo-grid .more svg.i{width:15px;height:15px;vertical-align:-3px}
@media (max-width:1060px){.logo-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.logo-grid li:nth-child(n+16):not(.more){display:none}}
@media (max-width:640px){
  .logo-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
  .logo-grid li:nth-child(n+9):not(.more){display:none}
  .logo-grid a{flex-direction:column;justify-content:center;text-align:center;gap:8px;padding:14px 6px;font-size:12.5px}
  .logo-grid a>span:last-child{max-width:100%}
}

/* Security */
.sec-layout{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:48px;align-items:start}
.sec-list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:28px 28px}
.sec-list li{display:flex;gap:14px;align-items:flex-start}
.sec-icon{flex:none;width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent-ink)}
.sec-icon svg{width:18px;height:18px}
.sec-list h3{font-size:15.5px;margin:2px 0 4px}
.sec-list p{margin:0;color:var(--muted);font-size:14px}
.log-card{align-self:center;background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:0 30px 60px -40px rgba(0,0,0,.45);overflow:hidden}
.log-head{display:flex;align-items:center;gap:8px;padding:13px 16px;border-bottom:1px solid var(--border);font-weight:600;font-size:14px}
.log-head svg{width:16px;height:16px;color:var(--accent-ink)}
.log-card ol{list-style:none;margin:0;padding:4px 0}
.log-row{display:grid;grid-template-columns:auto 92px minmax(0,1fr) auto;gap:10px;align-items:center;padding:11px 16px;font-size:13px}
.log-row+.log-row{border-top:1px solid var(--border)}
.log-row .time{color:var(--muted);font-size:12px}
.log-row .app{display:inline-flex;align-items:center;gap:6px;font-weight:560}
.log-row .app svg{width:14px;height:14px;flex:none}
.log-row .app svg:not([fill=none]){fill:currentColor}
.log-row .what{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.log-row .what b{color:var(--text);font-weight:600}
.log-row .status{font-size:12px;font-weight:560;padding:4px 8px;border-radius:999px;background:var(--ok-soft);color:var(--ok);white-space:nowrap}
.log-row.s-approved .status{background:var(--accent-soft);color:var(--accent-ink)}
.log-row.s-blocked .status{background:var(--danger-soft);color:var(--danger)}
@media (max-width:960px){.sec-layout{grid-template-columns:1fr;gap:36px}}
@media (max-width:640px){
  .sec-list{grid-template-columns:1fr;gap:22px}
  .log-row{grid-template-columns:auto minmax(0,1fr) auto;row-gap:4px}
  .log-row .status{grid-column:3;grid-row:1}
  .log-row .what{grid-column:2/-1;grid-row:2}
}

/* Questions */
.faq-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.7fr);gap:56px;align-items:start}
.faq-layout .section-head{margin-bottom:16px}
@media (min-width:861px){.faq-layout>:first-child{position:sticky;top:96px}}
.faq-more{margin:0}
.faq-list summary:focus-visible{outline-offset:6px}
@media (max-width:860px){.faq-layout{grid-template-columns:1fr;gap:8px}}

/* Final call to action */
.cta-band.glow{isolation:isolate}
.cta-band.glow::before{content:"";position:absolute;z-index:-1;width:560px;height:560px;right:-140px;top:-300px;pointer-events:none;background:radial-gradient(closest-side,color-mix(in srgb,var(--accent) 45%,transparent),transparent);opacity:.6}

/* Motion */
@keyframes lp-rise{from{opacity:0;transform:translateY(16px)}}
@keyframes lp-step{from{opacity:0;transform:translateY(8px)}}
@keyframes lp-fade{from{opacity:0}}
@keyframes lp-press{0%,55%{background:var(--card);color:var(--accent-ink);transform:none}70%{transform:scale(.95)}100%{transform:none}}
@keyframes lp-typing{0%{opacity:0}15%,85%{opacity:1}100%{opacity:0}}
@keyframes lp-dots{0%,100%{background-position:0 0}50%{background-position:0 -3px}}
@keyframes lp-hold{0%,90%{opacity:1;visibility:visible}100%{opacity:0;visibility:visible}}
@keyframes lp-glow{0%,22%{opacity:.3}36%{opacity:.85}62%,100%{opacity:.3}}
@keyframes lp-route{0%{stroke-dashoffset:22;opacity:1}13%{stroke-dashoffset:-100;opacity:1}13.5%,100%{stroke-dashoffset:-100;opacity:0}}
@keyframes lp-hit{0%,10%{border-color:color-mix(in srgb,var(--accent) 70%,transparent);color:#fff}18%,100%{border-color:${INK_LINE}}}
@keyframes lp-drift{to{transform:translate(-60px,40px)}}
@media (prefers-reduced-motion:no-preference){
  /* Hero: the copy settles in on load (the heading stays put: it is the page's main paint) */
  .hero .lead,.hero-actions,.hero-note{animation:lp-rise .7s cubic-bezier(.2,.7,.2,1) backwards}
  .hero .lead{animation-delay:.08s}.hero .hero-actions{animation-delay:.16s}.hero .hero-note{animation-delay:.24s}
  .hero .demo{animation:lp-rise .8s cubic-bezier(.2,.7,.2,1) .1s backwards}
  /* The chat plays its request once: the question is there from the first paint, the AI works,
     asks, the Allow button is pressed and the card settles into "Approved by you". */
  .demo .step:not(.s1){animation:lp-step .45s cubic-bezier(.2,.7,.2,1) backwards}
  .demo .step.s2{animation-delay:.4s}.demo .step.s3{animation-delay:.75s}.demo .step.s4{animation-delay:1.1s}.demo .step.s5{animation-delay:3.6s}.demo .step.s6{animation-delay:3.9s}
  .demo .approve .btns{animation:lp-hold 3.4s linear}
  .demo .approve .yes{animation:lp-press .9s ease 2.4s backwards}
  .demo .approve .approved{animation:lp-fade .3s ease 3.4s backwards}
  .demo .typing{animation:lp-typing .7s linear 3.9s backwards,lp-dots .5s ease-in-out 3.9s 2}
  .demo .s6 .text{animation:lp-fade .4s ease 4.5s backwards}
  .js .demo-replay{display:inline-grid;place-items:center;animation:lp-fade .3s ease 5s backwards}
  .demo.replay,.demo.replay *{animation:none!important}
  .reveal .demo:not(.in) *{animation-play-state:paused}
  /* Sections rise in once as they come into view */
  .reveal [data-reveal=""]:not(.in),.reveal [data-reveal=kids]:not(.in)>*{opacity:0}
  .reveal [data-reveal=""].in,.reveal [data-reveal=kids].in>*{animation:lp-rise .7s cubic-bezier(.2,.7,.2,1) backwards}
  .reveal [data-reveal=""].now,.reveal [data-reveal=kids].now>*{animation:none}
  ${STAGGER}
  /* Feature visuals do their thing once their tile is in view */
  .reveal .bento:not(.in) .light-up .chip.on{background:var(--bg-subtle);border-color:var(--border);color:var(--text)}
  .light-up .chip.on:nth-child(1){transition-delay:.5s}.light-up .chip.on:nth-child(2){transition-delay:.7s}.light-up .chip.on:nth-child(3){transition-delay:.9s}
  .reveal .bento:not(.in) .fill{transform:scaleX(0)}
  .reveal .bento.in .rules li{animation:lp-step .4s cubic-bezier(.2,.7,.2,1) backwards}
  .reveal .bento.in .rules li:nth-child(2){animation-delay:.6s}.reveal .bento.in .rules li:nth-child(3){animation-delay:.75s}
  .reveal .bento.in .rules li:first-child{animation-delay:.45s}
  .reveal .bento.in .bubble.ai{animation:lp-rise .5s cubic-bezier(.2,.7,.2,1) 1s backwards}
  .reveal .bento.in .ok-pill{animation:lp-fade .4s ease 1s backwards}
  /* The hub: packets run along the wires while it is on screen */
  /* Three requests in a 7.2s loop: Claude → Gmail work, ChatGPT → Slack client, Cursor → GitHub */
  .w-in .p1,.w-in .p2,.w-in .p3,.w-out .p1,.w-out .p2,.w-out .p4{animation:lp-route 7.2s cubic-bezier(.45,0,.55,1) 3}
  .hubmap .clients li:nth-child(-n+3) .node,.hubmap .services li:nth-child(1) .map-acc:first-child,.hubmap .services li:nth-child(2) .map-acc:last-child,.hubmap .services li:nth-child(4) .node{animation:lp-hit 7.2s ease 3}
  .w-in .p2,.hubmap .clients li:nth-child(2) .node{animation-delay:2.4s}
  .w-in .p3,.hubmap .clients li:nth-child(3) .node{animation-delay:4.8s}
  .w-out .p1{animation-delay:.95s}.w-out .p2{animation-delay:3.35s}.w-out .p4{animation-delay:5.75s}
  .hubmap .services li:nth-child(1) .map-acc:first-child{animation-delay:1.7s}
  .hubmap .services li:nth-child(2) .map-acc:last-child{animation-delay:4.1s}
  .hubmap .services li:nth-child(4) .node{animation-delay:6.5s}
  .core-glow{animation:lp-glow 2.4s ease-in-out 9 forwards}
  .reveal [data-live]:not(.live) *{animation-play-state:paused}
  .cta-band.glow::before{animation:lp-drift 14s ease-in-out 2 alternate}
}
`;
