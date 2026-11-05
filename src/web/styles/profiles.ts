import { MONO, SANS } from '../assets.js';

/** Access profiles (`/app/profiles`): the account picker and the address field. */
export const PROFILES_CSS = `
.profile-form .grid-2.tight{gap:14px 16px;margin:0}
.profile-form .grid-2.tight label{margin-top:0}
.prefixed{display:flex;align-items:stretch;border:1px solid var(--border-strong);border-radius:10px;background:var(--card);overflow:hidden}
.prefixed:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.prefixed .prefix{flex:none;display:flex;align-items:center;padding:0 1px 0 12px;font:13.5px/1 ${MONO};color:var(--muted);white-space:nowrap}
.prefixed input[type=text]{flex:1;width:auto;border:0;border-radius:0;box-shadow:none;padding-left:0;font-family:${MONO};font-size:13.5px;min-width:0}
.prefixed input[type=text]:focus{box-shadow:none}
.pick-fieldset,.profile-form .choice-list{border:0;padding:0;margin:18px 0 0;min-width:0}
.pick-fieldset legend,.profile-form .choice-list legend{font-weight:560;font-size:14px;padding:0;margin:0 0 4px}
.pick-fieldset .hint{margin:0 0 6px}
.pick-fieldset{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}
.pick-fieldset>legend,.pick-fieldset>.hint,.pick-group{grid-column:1/-1}
.pick-group{margin:6px 0 0;font:600 12.5px/1.2 ${SANS};color:var(--muted)}
.pick{display:flex;gap:10px;align-items:center;padding:10px 12px;margin:0;border:1px solid var(--border);border-radius:12px;cursor:pointer;font-weight:450;min-width:0}
.pick:has(input:checked){border-color:var(--accent);background:var(--accent-soft)}
.pick input[type=checkbox]{margin:0;flex:none}
.pick>span{display:flex;flex-direction:column;gap:2px;min-width:0}
.pick strong,.pick code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pick code{background:none;border:0;padding:0;font-size:12px}
.profile-form .choice-list{gap:8px}
.profile-form .choice{margin:0}
@media (max-width:520px){.prefixed .prefix{max-width:60%;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto}}
`;
