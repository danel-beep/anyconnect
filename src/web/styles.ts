import { themeCss } from './theme.js';

/** Served at /assets/app.css (no inline styles, so the CSP can forbid them). Colors come from `theme.ts`. */
export const APP_CSS = `
${themeCss()}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}
main.narrow{max-width:440px}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin:0 0 16px}
h1{font-size:22px;margin:0 0 8px}
h2{font-size:17px;margin:0 0 12px}
p{margin:0 0 12px}
.muted{color:var(--muted)}
.small{font-size:13px}
label{display:block;font-weight:600;margin:12px 0 4px}
input[type=email],input[type=password],input[type=text]{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}
input[readonly]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px}
button{font:inherit;font-weight:600;border-radius:8px;padding:10px 16px;border:1px solid var(--border);background:var(--card);color:var(--text);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
button.danger{color:var(--danger)}
button.link{border:0;background:none;padding:0;color:var(--accent-ink);font-weight:500}
a{color:var(--accent-ink)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.actions{display:flex;gap:12px;margin-top:20px}
.actions button{flex:1}
.error{color:var(--danger);margin:8px 0 0}
.warning{background:var(--warn-bg);border:1px solid var(--warn-border);border-radius:8px;padding:10px 12px;margin:12px 0}
.badge{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:99px;border:1px solid var(--border);color:var(--muted)}
.badge.ok{color:var(--ok);border-color:var(--ok)}
.badge.bad{color:var(--danger);border-color:var(--danger)}
ul.plain{list-style:none;padding:0;margin:0}
ul.plain li{padding:10px 0;border-top:1px solid var(--border);display:flex;justify-content:space-between;gap:12px;align-items:center}
ul.plain li:first-child{border-top:0}
ul.bullets{margin:4px 0 12px;padding-left:20px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 6px;border-top:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:600;border-top:0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
header.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.brand{font-weight:800;font-size:18px;letter-spacing:-.01em}
form.inline{display:inline}
`;
