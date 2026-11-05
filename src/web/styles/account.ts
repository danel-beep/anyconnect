/**
 * The Security and Settings pages: section headings with icon tiles, the protection checklist,
 * the "Ask your AI" requests to copy, option cards and the folded danger zone.
 */
export const ACCOUNT_CSS = `
.sec-head{display:flex;align-items:flex-start;gap:14px;margin:0 0 18px}
.sec-head h2{margin:2px 0 4px;font-size:18px}
.sec-head p{margin:0}
.sec-head>.badge,.sec-head>form{flex:none;margin-top:6px}
.sec-icon,.row-icon,.step-mark{display:inline-grid;place-items:center;flex:none;border-radius:10px;background:var(--accent-soft);color:var(--accent-ink)}
.sec-icon{width:38px;height:38px}
.sec-icon svg{width:19px;height:19px}
.row-icon{width:32px;height:32px;border-radius:9px;background:var(--bg-subtle);color:var(--muted);border:1px solid var(--border)}
.row-icon svg{width:16px;height:16px}
ul.plain>li:has(>.row-icon){justify-content:flex-start}
.row-icon+.grow{display:flex;flex-direction:column;gap:2px}
.sub-block{margin-top:20px;padding-top:18px;border-top:1px solid var(--border)}
.link-row{display:flex;align-items:center;gap:12px;margin-top:12px;padding:12px 14px;border:1px solid var(--border);border-radius:12px;color:var(--text);text-decoration:none;font-weight:560}
.link-row:hover{border-color:var(--accent);text-decoration:none}
.link-row>svg{width:16px;height:16px;color:var(--muted);flex:none}

/* Protection summary on /security */
.protect-head{display:flex;gap:8px 16px;align-items:flex-start;flex-wrap:wrap;margin:0 0 14px}
.protect-head h2{font-size:21px;margin:0 0 6px}
.protect-head p{margin:0}
.level-strong,.level-good{color:var(--ok)}
.level-basic{color:var(--accent-ink)}
.seg-bar{display:flex;gap:6px;margin:0 0 18px}
.seg{flex:1;height:8px;border-radius:99px;background:var(--border)}
.seg.on{background:var(--ok)}
.step-list{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.step-item{display:flex;align-items:center;gap:12px;height:100%;padding:12px 14px;border:1px solid var(--border);border-radius:12px;color:var(--text);text-decoration:none}
.step-item:hover{border-color:var(--accent);text-decoration:none}
.step-item .grow{display:flex;flex-direction:column;gap:2px}
.step-item.done{background:var(--bg-subtle)}
.step-mark{width:34px;height:34px}
.step-mark svg{width:17px;height:17px}
.step-next{display:inline-flex;align-items:center;gap:6px;flex:none;padding:7px 12px;border-radius:99px;background:var(--accent);color:var(--accent-text);font-weight:600;font-size:13px;line-height:1;white-space:nowrap}
.step-next svg{width:14px;height:14px}
.step-item:has(.step-next){border-color:var(--accent)}
.step-item.done .step-mark{background:var(--ok-soft);color:var(--ok)}
@media (max-width:700px){.step-list{grid-template-columns:1fr}}

/* Requests to copy into the AI app */
.ask-ai{margin-top:20px;padding:16px;border-radius:12px;background:var(--accent-soft);border:1px solid color-mix(in srgb,var(--accent) 35%,transparent)}
.ask-ai .sec-icon{background:var(--accent);color:var(--accent-text)}
.ask-ai-head{display:flex;gap:12px;align-items:flex-start;margin:0}
.ask-ai-head .grow{display:flex;flex-direction:column;gap:2px}

/* Option cards in Settings */
.grid-2.top{align-items:start}
.choice-cols{display:grid;gap:20px;margin-bottom:4px}
.choice-cols .choice-list{margin:0;min-width:0}
.choice-cols .choice strong .badge{display:inline-flex;flex-direction:row;margin-left:8px;vertical-align:1px}
.choice-cols legend{font-weight:600;font-size:14px;padding:0;margin:0 0 8px}

/* The danger zone, folded until asked for */
details.danger-zone:not([open]){border-color:var(--border)}
details.danger-zone:not([open]):hover{border-color:var(--danger)}
details.danger-zone>summary{display:flex;align-items:center;gap:12px;padding:0 32px 0 0;font-size:15px;font-weight:400}
.danger-zone summary strong{color:var(--danger)}
.danger-zone .row-icon{background:var(--danger-soft);color:var(--danger);border-color:transparent}
.danger-body{margin-top:18px;padding:16px 0 0;border-top:1px solid var(--border);color:var(--text);max-width:none}
/* Phones: the status moves under the text instead of squeezing it into a narrow column. */
@media (max-width:560px){
  .sec-head{flex-wrap:wrap;column-gap:12px}
  .sec-head>.grow{flex-basis:calc(100% - 50px)}
  .sec-head>.badge,.sec-head>form{margin:0 0 0 50px}
  .step-item{flex-wrap:wrap;column-gap:12px;row-gap:8px}
  .step-item .grow{flex-basis:calc(100% - 46px)}
  .step-item>.badge,.step-item>.step-next{margin-left:46px}
  .protect-head>.grow{flex-basis:100%}
}
`;
