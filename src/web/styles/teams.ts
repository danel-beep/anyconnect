/**
 * Team pages (`/app/teams`, `/app/team/:slug`), the summary of "Plan and limits" (`/app/billing`) and
 * the ready texts to copy (`CopyText`).
 */
export const TEAMS_CSS = `
.onboard-steps.two{grid-template-columns:repeat(2,1fr)}
@media (max-width:900px){.onboard-steps.two{grid-template-columns:1fr}}

.team-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin:0 0 16px}
.team-tile{display:flex;align-items:center;gap:14px;padding:18px 20px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);text-decoration:none;min-width:0}
.team-tile:hover{border-color:var(--accent);text-decoration:none}
.team-tile strong{display:block;font-size:16px;overflow-wrap:anywhere}
.team-tile .small{display:block;margin-top:2px}
.team-tile>svg{width:18px;height:18px;flex:none;color:var(--muted)}
.team-tile:hover>svg{color:var(--accent-ink)}
.team-mark{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;flex:none;background:var(--accent);color:var(--accent-text);font-weight:680;font-size:16px;letter-spacing:.02em;text-transform:uppercase}

.team-intro h2{margin-bottom:16px}
.team-steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.team-steps li{display:flex;flex-direction:column;gap:6px;padding:18px;border-radius:12px;background:var(--code-bg);border:1px solid var(--border)}
.team-steps strong{font-size:15px}
.team-steps .muted{font-size:13.5px}
.team-step-icon{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent-ink);margin-bottom:6px}
.team-step-icon svg{width:20px;height:20px}
.team-facts{list-style:none;margin:16px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:8px 20px;font-size:13.5px;color:var(--muted)}
.team-facts li{display:flex;align-items:center;gap:6px}
.team-facts svg{width:15px;height:15px;color:var(--ok);flex:none}
@media (max-width:760px){.team-steps{grid-template-columns:1fr}}

ul.plain>li.person{justify-content:flex-start;flex-wrap:wrap}
li.person>.grow{min-width:min(100%,220px)}
li.person .badge svg{width:12px;height:12px}
@media (max-width:640px){li.person>form{margin-left:44px}}

.copy-text{display:flex;gap:12px;align-items:flex-start;padding:14px 16px;border:1px solid var(--border);border-radius:12px;background:var(--code-bg);margin:12px 0}
.copy-text>p{flex:1;min-width:0;margin:0;white-space:pre-line;overflow-wrap:anywhere;font-size:14px}
div.copy-text>button{flex:none}
button.copy-text.prompt{gap:12px;width:100%;min-width:0;max-width:100%;white-space:normal;height:auto;justify-content:flex-start;margin:0;align-items:center;text-align:left;font:inherit;color:var(--text);background:var(--card);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:12px;padding:12px 14px;cursor:pointer;box-shadow:none}
button.copy-text.prompt:hover{border-color:var(--accent);background:var(--accent-soft)}
.prompt-text{flex:1;min-width:0;font-size:14.5px;line-height:1.45;overflow-wrap:anywhere}
.prompt-action{flex:none;display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:560;color:var(--accent-ink)}
.prompt-action svg{width:15px;height:15px}
.prompt-list{display:grid;gap:8px;margin-top:12px}
@media (max-width:520px){div.copy-text{flex-direction:column;align-items:stretch}div.copy-text button{align-self:flex-start}}


.plan-hero-head{display:flex;gap:16px;align-items:flex-start;margin-bottom:16px}
.plan-hero-head .eyebrow{margin-bottom:10px}
.plan-hero-head h2{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;font-size:28px;letter-spacing:-.03em;margin:0 0 6px}
.plan-hero-head h2 .badge{font-size:12.5px;letter-spacing:0}
.plan-hero-head p{margin:0}
.plan-hero-head>.btn{flex:none}
.plan-hero>.notice{margin:0 0 16px}
@media (max-width:640px){.plan-hero-head{flex-direction:column}.plan-hero-head>.btn{width:100%}}

ol.timeline{list-style:none;margin:12px 0 0;padding:0;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:0}
ol.timeline li{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:22px 12px 0 0}
ol.timeline li::before{content:"";position:absolute;top:6px;left:0;right:0;height:2px;background:var(--border)}
ol.timeline li:last-child::before{right:auto;width:14px}
ol.timeline .tl-dot{position:absolute;top:0;left:0;width:14px;height:14px;border-radius:50%;background:var(--card);border:2px solid var(--border-strong)}
ol.timeline strong{font-size:14px;font-weight:600}
ol.timeline strong .badge{margin-left:6px;vertical-align:1px}
ol.timeline li.current .tl-dot{border-color:var(--accent);background:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
ol.timeline li.past{opacity:.55}
ol.timeline li.past .tl-dot{background:var(--border-strong)}
@media (max-width:760px){
  ol.timeline{grid-auto-flow:row}
  ol.timeline li{padding:0 0 18px 28px}
  ol.timeline li::before{top:14px;bottom:0;left:6px;right:auto;width:2px;height:auto}
  ol.timeline li:last-child::before{display:none}
  ol.timeline li:last-child{padding-bottom:0}
}
`;
