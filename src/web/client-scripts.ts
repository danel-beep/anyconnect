import { CYRILLIC } from '../lib/slug.js';

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
/* The open menu floats above the page (position:fixed), so no card or scroll box clips it: it sits under
   its button, opens upwards when there is no room below and stays inside the window. */
function placeMenu(m){var pop=m.querySelector('.menu-pop'),s=m.querySelector('summary');if(!pop||!s)return;
pop.classList.add('floating');pop.style.left='0px';pop.style.top='0px';var r=s.getBoundingClientRect(),vw=root.clientWidth,vh=window.innerHeight,w=pop.offsetWidth,h=pop.offsetHeight,gap=6;
var below=vh-r.bottom-gap,above=r.top-gap,top=(h<=below||below>=above)?r.bottom+gap:r.top-gap-h;
pop.style.left=Math.max(8,Math.min(r.right-w,vw-w-8))+'px';pop.style.top=Math.max(8,Math.min(top,vh-h-8))+'px'}
function placeOpen(){menus.forEach(function(m){if(m.open)placeMenu(m)})}
menus.forEach(function(m){m.addEventListener('toggle',function(){if(m.open){menus.forEach(function(o){if(o!==m)o.open=false});placeMenu(m)}})});
window.addEventListener('resize',placeOpen);window.addEventListener('scroll',placeOpen,{passive:true,capture:true});
d.addEventListener('click',function(e){menus.forEach(function(m){if(m.open&&!m.contains(e.target))m.open=false})});
d.addEventListener('keydown',function(e){if(e.key!=='Escape')return;menus.forEach(function(m){if(m.open){m.open=false;var s=m.querySelector('summary');if(s)s.focus()}});setNav(false)});

/* Live filter: every word typed must appear in an item's data-search. Optional attributes:
   data-filter-expand opens a <details> while searching (and restores it after), data-filter-hide hides a
   block (e.g. a short "popular" row), data-filter-count announces "{n} found" in a live region,
   data-filter-clear shows a clear button, data-filter-enter opens the first match on Enter. Escape
   clears. Items inside a group switched off by category chips (data-chip-off) count as hidden. */
function shown(el){return !el.hidden&&!(el.closest&&el.closest('[data-chip-off]'))}
$$('[data-filter]').forEach(function(input){var box=d.querySelector(input.getAttribute('data-filter'));if(!box)return;
function sel(a){var v=input.getAttribute(a);return v?d.querySelector(v):null}
var expand=sel('data-filter-expand'),hide=sel('data-filter-hide'),count=sel('data-filter-count'),clear=sel('data-filter-clear'),wasOpen=null;
function run(){var q=input.value.trim().toLowerCase(),words=q?q.split(/\\s+/):[];if(q)box.dispatchEvent(new Event('filtering'));
$$('[data-search]',box).forEach(function(el){var text=el.getAttribute('data-search').toLowerCase();el.hidden=!words.every(function(w){return text.indexOf(w)>=0})});
$$('[data-filter-group]',box).forEach(function(g){g.hidden=$$('[data-search]',g).every(function(el){return el.hidden})});
if(hide)hide.hidden=q!=='';if(clear)clear.hidden=input.value==='';
if(expand){if(q!==''){if(wasOpen===null)wasOpen=expand.open;expand.open=true;expand.setAttribute('data-searching','')}else{expand.removeAttribute('data-searching');if(wasOpen!==null)expand.open=wasOpen;wasOpen=null}}
var n=$$('[data-search]',box).filter(shown).length;
if(count)count.textContent=q?(count.getAttribute('data-template')||'{n}').replace('{n}',String(n)):'';
var empty=input.getAttribute('data-filter-empty');var none=empty&&d.querySelector(empty);if(none)none.hidden=n>0}
input.addEventListener('input',run);box.addEventListener('chips',run);
if(clear)clear.addEventListener('click',function(){input.value='';run();input.focus()});
input.addEventListener('keydown',function(e){if(e.key==='Escape'&&input.value){e.preventDefault();input.value='';run()}
if(e.key==='Enter'&&input.hasAttribute('data-filter-enter')){e.preventDefault();var first=$$('[data-search]',box).filter(shown).map(function(el){return el.querySelector('a.stretch')}).filter(Boolean)[0];if(first)first.click()}})});

/* Category chips: show one category of a list (data-chips="#list", buttons data-chip="<group>", "" for all) */
$$('[data-chips]').forEach(function(bar){var box=d.querySelector(bar.getAttribute('data-chips'));if(!box)return;bar.hidden=false;var chips=$$('[data-chip]',bar);
function pick(v){chips.forEach(function(x){x.setAttribute('aria-pressed',x.getAttribute('data-chip')===v?'true':'false')});
$$('[data-group]',box).forEach(function(g){if(v&&g.getAttribute('data-group')!==v)g.setAttribute('data-chip-off','');else g.removeAttribute('data-chip-off')})}
/* Typing a search looks through every category */
box.addEventListener('filtering',function(){if($$('[data-chip-off]',box).length)pick('')});
chips.forEach(function(c){c.addEventListener('click',function(){pick(c.getAttribute('data-chip'));box.dispatchEvent(new Event('chips'));
/* Keep the start of the list right under the (sticky) bar instead of leaving the page scrolled into nothing */
var stick=bar.closest('[data-sticky-bar]')||bar.parentElement,r=box.getBoundingClientRect(),under=stick.getBoundingClientRect().bottom;if(r.top<under)window.scrollBy(0,r.top-under-8)})})});

/* Buttons that close a <details> (e.g. "Show fewer") and bring its top back into view */
$$('[data-collapse]').forEach(function(b){var t=d.querySelector(b.getAttribute('data-collapse'));if(!t)return;b.hidden=false;
b.addEventListener('click',function(){t.open=false;
var h=location.hash&&d.getElementById(location.hash.slice(1));if(h&&t.contains(h)&&history.replaceState)history.replaceState(null,'',location.pathname+location.search);
var s=t.querySelector('summary');if(s){s.focus({preventScroll:true});var r=s.getBoundingClientRect();if(r.top<0||r.bottom>window.innerHeight)s.scrollIntoView({block:'center'})}})});

/* A link to a folded section (#custom) or to something inside one (#add-gmail) opens it */
function openTarget(){var id=location.hash.slice(1);if(!id)return;var t=null;try{t=d.getElementById(decodeURIComponent(id))}catch(e){}
var det=t&&(t.tagName==='DETAILS'?t:t.closest('details'));while(det){det.open=true;det=det.parentElement&&det.parentElement.closest('details')}}
openTarget();window.addEventListener('hashchange',openTarget);

/* Filter forms apply as soon as a choice changes (the button stays for keyboards and no-JS) */
$$('form[data-autosubmit]').forEach(function(f){f.addEventListener('change',function(){f.submit()})});

/* Docs: the side menu marks the section being read */
(function(){var spy=d.querySelector('.doc-nav');
if(!spy||!('IntersectionObserver' in window))return;var links={},seen={};
$$('a[href^="#"]',spy).forEach(function(a){links[a.getAttribute('href').slice(1)]=a});
var io=new IntersectionObserver(function(es){es.forEach(function(e){seen[e.target.id]=e.isIntersecting});
var cur=null;for(var id in links){if(seen[id]){cur=id;break}}if(!cur)return;
for(var k in links){if(k===cur)links[k].setAttribute('aria-current','location');else links[k].removeAttribute('aria-current')}},{rootMargin:'-80px 0px -60% 0px'});
for(var id in links){var el=d.getElementById(id);if(el)io.observe(el)}})();

/* Setup guide: opens the steps for the provider picked in the form, or the one the address points to */
$$('[data-guide]').forEach(function(g){var domains={};try{domains=JSON.parse(g.getAttribute('data-guide-domains')||'{}')}catch(e){}
var fieldName=g.getAttribute('data-guide-field'),mailName=g.getAttribute('data-guide-email');
var pick=fieldName&&d.querySelector('[name="'+fieldName+'"]'),mail=mailName&&d.querySelector('[name="'+mailName+'"]'),last=null;
function fromMail(){var v=(mail&&mail.value||'').trim().toLowerCase(),at=v.lastIndexOf('@');if(at<0)return '';var dom=v.slice(at+1);
for(var k in domains){if(domains[k].indexOf(dom)>=0)return k}return /\\.[a-z]{2,}$/.test(dom)?'custom':''}
function update(){var key=(pick&&pick.value)||fromMail();if(key===last)return;last=key;
$$('[data-variant]',g).forEach(function(v){var on=v.getAttribute('data-variant')===key;v.open=on;if(on)v.setAttribute('data-matched','');else v.removeAttribute('data-matched');var b=v.querySelector('[data-variant-match]');if(b)b.hidden=!on})}
if(pick)pick.addEventListener('change',update);if(mail)mail.addEventListener('input',update);update()});

/* Access profiles: the address field shows the address the name gives (the hub makes it when left empty) */
var TR=${JSON.stringify(CYRILLIC)};
function slug(v){var l=v.toLowerCase(),s='';for(var i=0;i<l.length;i++){var ch=l.charAt(i);s+=TR.hasOwnProperty(ch)?TR[ch]:ch}
if(s.normalize)s=s.normalize('NFKD').replace(/[\\u0300-\\u036f]/g,'');return s.replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,28).replace(/-+$/,'')}
$$('[data-slug-target]').forEach(function(src){var out=d.querySelector(src.getAttribute('data-slug-target'));if(!out)return;var empty=out.getAttribute('placeholder')||'';
function update(){out.setAttribute('placeholder',slug(src.value)||empty)}src.addEventListener('input',update);update()});

/* A page shown in answer to a form post (e.g. a new token) gets a clean address, so reloading it
   does not post the form again. */
var clean=d.querySelector('[data-replace-url]');if(clean&&history.replaceState)history.replaceState(null,'',clean.getAttribute('data-replace-url'));
})();`;

/**
 * The Paddle checkout page (`/billing/paddle/checkout`): opens Paddle's overlay for the transaction
 * the hub created. Paddle.js itself comes from Paddle's CDN; this file only passes it our settings
 * from data attributes (the page CSP allows no inline scripts).
 */
export const PADDLE_CHECKOUT_JS = `(function(){
'use strict';
var el=document.getElementById('paddle-checkout');if(!el)return;
var P=window.Paddle;if(!P){el.setAttribute('data-failed','');return}
var data=el.dataset,done=false;
if(data.sandbox==='1')P.Environment.set('sandbox');
P.Initialize({token:data.token,checkout:{settings:{displayMode:'overlay',successUrl:data.success,locale:data.lang,allowLogout:false}},
eventCallback:function(e){if(!e||!e.name)return;if(e.name==='checkout.completed')done=true;if(e.name==='checkout.closed')location.href=done?data.success:data.back}});
var q=new URLSearchParams(location.search);
/* Links Paddle sends itself (default payment link with _ptxn) are opened by Paddle.js. */
if(data.txn&&!q.get('_ptxn')){var opts={transactionId:data.txn};if(data.email)opts.customer={email:data.email};P.Checkout.open(opts)}
})();`;
