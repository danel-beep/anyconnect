import { MONO } from '../assets.js';

/** Triggers (`/app/triggers`) and the AI API keys page (`/app/ai`). */
export const TRIGGERS_CSS = `
.trigger-how{margin:0 0 14px;padding-left:20px;display:grid;gap:6px;color:var(--text)}
ul.plain>li.trigger-row,ul.plain>li.trigger-event{align-items:flex-start}
.trigger-row .grow>div,.trigger-event .grow>div{margin-top:3px}
.trigger-row code.small{margin-left:6px;overflow-wrap:anywhere}
.trigger-row>.grow{flex:1 1 220px}
.trigger-actions{display:flex;gap:8px;flex:none}
.trigger-actions form{margin:0}
.trigger-event>.small{flex:none;white-space:nowrap}
.trigger-event .grow{min-width:0;overflow-wrap:anywhere}
.trigger-form .grid-2.tight{gap:14px 16px;margin:0}
.trigger-form .grid-2.tight label{margin-top:0}
.trigger-form input+.grid-2.tight,.trigger-form .grid-2.tight+.grid-2.tight{margin-top:14px}
.trigger-filter,.trigger-form .choice-list{border:0;padding:0;margin:18px 0 16px;min-width:0}
.trigger-filter legend,.trigger-form .choice-list legend{font-weight:560;font-size:14px;padding:0;margin:0 0 4px}
.trigger-filter>.hint{margin:0 0 10px}
.trigger-form textarea{min-height:84px;resize:vertical}
.trigger-form textarea[name=args],.trigger-form input[name=tool],.trigger-form input[name=tools]{font-family:${MONO};font-size:13.5px}
.trigger-more{display:none;margin:0 0 16px}
.trigger-more>.hint:first-child{margin:0}
.trigger-more .notice{margin:0 0 12px}
.trigger-more .check-label{margin:12px 0 0;font-weight:450}
.trigger-form:has(input[name=do][value=check]:checked) .trigger-more.for-check,
.trigger-form:has(input[name=do][value=notify]:checked) .trigger-more.for-notify,
.trigger-form:has(input[name=do][value=tool]:checked) .trigger-more.for-tool,
.trigger-form:has(input[name=do][value=ai]:checked) .trigger-more.for-ai{display:block}
.trigger-nolimit{align-self:end;margin:0 0 12px;font-weight:450}
ul.plain>li.key-row{display:grid;grid-template-columns:minmax(0,1fr);justify-content:stretch;gap:10px;align-items:stretch}
.key-head{display:flex;gap:12px;align-items:flex-start}
.key-head .grow{min-width:0;overflow-wrap:anywhere}
.key-head form{margin:0}
.key-error{color:var(--danger);margin-top:3px}
.trigger-kinds-title{margin:20px 0 10px;font-size:14.5px;font-weight:600}
.trigger-kinds{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.trigger-kinds li{display:flex;flex-direction:column;gap:3px;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:var(--bg-subtle);min-width:0}
.trigger-kinds li strong{font-size:14.5px}
.key-paste{display:flex;gap:10px;align-items:stretch}
.key-paste input{flex:1;min-width:0}
.key-paste button{flex:none}
.trigger-form .key-paste+.hint{margin:10px 0 0}
.key-change{margin:0}
details.key-edit{border:0;margin:0}
details.key-edit summary{padding:0 0 0 18px;font-size:13px;font-weight:560;color:var(--accent-ink)}
details.key-edit summary::after{left:2px;right:auto;width:7px;height:7px;transform:translateY(-50%) rotate(-45deg)}
details.key-edit[open] summary::after{transform:translateY(-70%) rotate(45deg)}
details.key-edit .inline-form{margin-top:12px}
details.key-edit .hint{margin:8px 0 0}
@media (max-width:640px){.trigger-kinds{grid-template-columns:1fr}.key-paste{flex-direction:column}}
@media (max-width:640px){ul.plain>li.trigger-row,ul.plain>li.trigger-event{flex-wrap:wrap}.trigger-event>.small{white-space:normal}}
`;
