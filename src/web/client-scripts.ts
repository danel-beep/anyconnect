/**
 * The website's two small scripts, served from our own origin (`script-src 'self'`).
 * Every page works without them; they only add comfort: theme switch, copy buttons, tabs,
 * filters, menus and confirmations.
 */

/** Runs in <head> before the first paint: marks JS as available and applies the saved theme. */
export const THEME_JS = `(function(){var d=document.documentElement;d.classList.add('js');try{var t=localStorage.getItem('ac-theme');if(t==='light'||t==='dark')d.setAttribute('data-theme',t)}catch(e){}})();`;

export const SITE_JS = `(function(){
'use strict';
var d=document,root=d.documentElement;
function $$(sel,el){return Array.prototype.slice.call((el||d).querySelectorAll(sel))}
function store(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v)}catch(e){return null}}

/* Theme */
function dark(){var t=root.getAttribute('data-theme');if(t)return t==='dark';return window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches}
$$('[data-theme-toggle]').forEach(function(b){b.hidden=false;b.addEventListener('click',function(){var next=dark()?'light':'dark';root.setAttribute('data-theme',next);store('ac-theme',next)})});

/* Copy */
function flash(btn){btn.setAttribute('data-copied','');setTimeout(function(){btn.removeAttribute('data-copied')},1600)}
$$('[data-copy]').forEach(function(btn){btn.addEventListener('click',function(){var el=d.querySelector(btn.getAttribute('data-copy'));if(!el)return;var text=('value' in el&&el.value!==undefined)?el.value:el.textContent;
if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(text).then(function(){flash(btn)},function(){fallback(el,btn)})}else fallback(el,btn)})});
function fallback(el,btn){try{if(el.select){el.select()}else{var r=d.createRange();r.selectNodeContents(el);var s=getSelection();s.removeAllRanges();s.addRange(r)}d.execCommand('copy');flash(btn)}catch(e){}}
$$('[data-select-on-focus]').forEach(function(i){i.addEventListener('focus',function(){i.select()})});

/* Tabs */
$$('[data-tabs]').forEach(function(box){var tabs=$$('[role=tab]',box),key=box.getAttribute('data-remember');
function show(id,save){tabs.forEach(function(t){var on=t.getAttribute('data-tab')===id;t.setAttribute('aria-selected',on?'true':'false');t.tabIndex=on?0:-1;var p=d.getElementById(t.getAttribute('aria-controls'));if(p){if(on)p.removeAttribute('data-inactive');else p.setAttribute('data-inactive','')}});if(save&&key)store('ac-tab-'+key,id)}
tabs.forEach(function(t,i){t.addEventListener('click',function(){show(t.getAttribute('data-tab'),true)});t.addEventListener('keydown',function(e){var k=e.key,j=-1;if(k==='ArrowRight')j=(i+1)%tabs.length;if(k==='ArrowLeft')j=(i-1+tabs.length)%tabs.length;if(j>=0){e.preventDefault();tabs[j].focus();show(tabs[j].getAttribute('data-tab'),true)}})});
var saved=key&&store('ac-tab-'+key);if(saved&&tabs.some(function(t){return t.getAttribute('data-tab')===saved}))show(saved,false);else if(tabs[0])show(tabs[0].getAttribute('data-tab'),false)});

/* Mobile navigation */
function setNav(open){root.classList.toggle('nav-open',open);$$('[data-nav-toggle]').forEach(function(b){b.setAttribute('aria-expanded',open?'true':'false')})}
$$('[data-nav-toggle]').forEach(function(b){b.addEventListener('click',function(e){e.stopPropagation();setNav(!root.classList.contains('nav-open'))})});
d.addEventListener('click',function(e){if(!root.classList.contains('nav-open'))return;var nav=e.target.closest&&e.target.closest('.sidebar,.site-nav');if(!nav||e.target.closest('a'))setNav(false)});

/* Header shadow on scroll */
var header=d.querySelector('[data-site-header]');if(header){var onScroll=function(){header.classList.toggle('scrolled',window.scrollY>8)};onScroll();window.addEventListener('scroll',onScroll,{passive:true})}

/* Monthly / yearly prices */
$$('[data-interval-root]').forEach(function(box){$$('[data-interval-set]',box).forEach(function(b){b.addEventListener('click',function(){var v=b.getAttribute('data-interval-set');box.setAttribute('data-interval',v);$$('[data-interval-set]',box).forEach(function(x){x.setAttribute('aria-pressed',x===b?'true':'false')});$$('[data-interval-input]',box).forEach(function(i){i.value=v})})})});

/* Confirm before destructive forms */
d.addEventListener('submit',function(e){var f=e.target,msg=f.getAttribute&&f.getAttribute('data-confirm');if(msg&&!window.confirm(msg))e.preventDefault()},true);

/* Dropdown menus: one open at a time, close on outside click or Escape */
var menus=$$('details[data-menu]');
menus.forEach(function(m){m.addEventListener('toggle',function(){if(m.open)menus.forEach(function(o){if(o!==m)o.open=false})})});
d.addEventListener('click',function(e){menus.forEach(function(m){if(m.open&&!m.contains(e.target))m.open=false})});
d.addEventListener('keydown',function(e){if(e.key!=='Escape')return;menus.forEach(function(m){if(m.open){m.open=false;var s=m.querySelector('summary');if(s)s.focus()}});setNav(false)});

/* Live filter */
$$('[data-filter]').forEach(function(input){var box=d.querySelector(input.getAttribute('data-filter'));if(!box)return;
input.addEventListener('input',function(){var q=input.value.trim().toLowerCase();$$('[data-search]',box).forEach(function(el){el.hidden=q!==''&&el.getAttribute('data-search').toLowerCase().indexOf(q)<0});
$$('[data-filter-group]',box).forEach(function(g){g.hidden=$$('[data-search]',g).every(function(el){return el.hidden})})})});
})();`;
