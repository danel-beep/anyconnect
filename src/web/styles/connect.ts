import { MONO } from '../assets.js';

/**
 * Connecting a service: the two-column form with its setup guide, the "what the AI can do" card,
 * example prompts and the result page. The guide also appears on the service pages.
 */
export const CONNECT_CSS = `
.nowrap-row{flex-wrap:nowrap;gap:16px;align-items:center}
.connect-head .logo-tile{flex:none}
@media (max-width:600px){.connect-head .logo-tile.lg{width:44px;height:44px;border-radius:12px}.connect-head .logo-tile.lg svg{width:22px;height:22px}}
.connect-grid{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:16px;align-items:start}
.connect-grid>.card,.connect-aside>.card{margin:0}
.connect-aside{display:flex;flex-direction:column;gap:16px}
.to-guide{display:none;margin-left:auto;white-space:nowrap}
@media (max-width:1000px){.connect-grid{grid-template-columns:1fr}.connect-aside{display:contents}.to-guide{display:inline}}
.connect-form-card{padding:24px 26px}
.connect-form-card form>.field:first-of-type label{margin-top:4px}
.field label .req{color:var(--accent-ink)}
[aria-invalid=true]{border-color:var(--danger)!important}
[aria-invalid=true]:focus{box-shadow:0 0 0 3px var(--danger-soft)!important}
.field-check{display:flex;flex-wrap:wrap;align-items:center;margin:16px 0 0}
.field-check label{margin:0;order:2;font-weight:500}
.field-check input{order:1}
.field-check .hint{order:3;flex-basis:100%;margin-left:24px}
.guide-summary{display:flex;gap:8px;align-items:center;color:var(--muted);font-size:13.5px;margin:0 0 14px}
.guide-summary svg{width:16px;height:16px;flex:none}
.secure-note{display:flex;gap:8px;align-items:center;color:var(--muted);font-size:13px;margin:14px 0 0}
.secure-note svg{width:15px;height:15px;flex:none}

/* Setup guide */
.guide-card h2{margin-bottom:14px}
.guide-steps{list-style:none;counter-reset:step;padding:0;margin:0}
.guide-steps>li{counter-increment:step;position:relative;padding:0 0 14px 38px;font-size:14.5px;line-height:1.5}
.guide-steps>li::before{content:counter(step);position:absolute;left:0;top:-1px;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent-ink);font:650 12.5px/1 ${MONO}}
.guide-steps>li:not(:last-child)::after{content:"";position:absolute;left:12.5px;top:29px;bottom:3px;width:1px;background:var(--border)}
.guide-steps>li>span{display:block}
.step-link{margin-top:8px;gap:6px}
.btn.step-link svg{width:14px;height:14px}
.guide-variants{margin:6px 0 0}
.guide-variants-title{font-weight:600;font-size:14px;margin:4px 0 8px}
details.guide-variant{border:1px solid var(--border);border-radius:10px;margin:0 0 8px;padding:0 14px;background:var(--card)}
details.guide-variant:last-of-type{border-bottom:1px solid var(--border)}
details.guide-variant[data-matched]{border-color:var(--accent)}
details.guide-variant>summary{padding:11px 28px 11px 0;font-size:14.5px;font-weight:560;display:flex;align-items:center;gap:8px}
details.guide-variant>summary::after{width:8px;height:8px;right:4px}
details.guide-variant>.guide-steps{padding:4px 0 6px}
.tiny-badge{padding:3px 7px;font-size:11px}
.guide-tips{list-style:none;margin:14px 0 0;padding:12px 14px;border-radius:10px;background:var(--bg-subtle);border:1px solid var(--border);font-size:13.5px;color:var(--muted)}
.guide-tips li{padding-left:16px;position:relative}
.guide-tips li+li{margin-top:6px}
.guide-tips li::before{content:"";position:absolute;left:2px;top:.62em;width:5px;height:5px;border-radius:50%;background:var(--accent)}

/* What the AI can do */
.ai-can-do h2{margin-bottom:6px}
.can-do-list{list-style:none;padding:0;margin:10px 0 12px;max-height:360px;overflow:auto}
.can-do-list li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--border);font-size:14px}
.can-do-list li:first-child{border-top:0}
.ai-can-do p.small{margin:0 0 6px}

/* Example prompts */
.prompt-list{list-style:none;padding:0;margin:10px 0 0}
.prompt-list li{display:flex;align-items:center;gap:8px;padding:6px 6px 6px 14px;margin:0 0 8px;border:1px solid var(--border);border-radius:10px;background:var(--bg-subtle);font-size:14.5px}
.prompt-list li>span{flex:1;min-width:0}
.prompt-list li>span::before{content:"\\201C"}
.prompt-list li>span::after{content:"\\201D"}
.prompt-list .icon-btn{width:34px;height:34px;min-height:34px;flex:none}

/* Result pages */
.connected{max-width:640px;margin:8px auto 0}
.connected-card{padding:32px}
.connected-card h1{font-size:24px;margin:0 0 8px}
.connected-logos{position:relative;display:inline-block;margin:0 0 18px}
.result-icon{position:absolute;right:-8px;bottom:-8px;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;border:3px solid var(--card)}
.result-icon svg{width:14px;height:14px;stroke-width:2.6}
.result-icon.ok{background:var(--ok);color:var(--card)}
.result-icon.warn{background:var(--warn-border);color:var(--card)}
.try-it{margin:22px 0 4px;padding:18px 0 0;border-top:1px solid var(--border)}
.try-it h2{margin:0}
.try-it p.small{margin:6px 0 0}
`;
