/** Served at /assets/app.css (no inline styles, so the CSP can forbid them). */
export const APP_CSS = `
:root{--bg:#f6f7f9;--card:#fff;--text:#16181d;--muted:#5d6472;--border:#e2e5ea;--accent:#3b5bfd;--accent-text:#fff;--danger:#c4372d;--ok:#1f8a4c;--warn-bg:#fff6e0;--warn-border:#f0c36a;--radius:12px}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--text:#e8eaef;--muted:#9aa2b1;--border:#2a2f3a;--accent:#6c84ff;--accent-text:#0b0d12;--danger:#ff6b5e;--ok:#4cc27e;--warn-bg:#2b2416;--warn-border:#6b5520}}
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
button.link{border:0;background:none;padding:0;color:var(--accent);font-weight:500}
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
