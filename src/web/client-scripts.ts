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
/* Delegated, so copy buttons in blocks that live updates replace keep working. */
d.addEventListener('click',function(e){var btn=e.target&&e.target.closest?e.target.closest('[data-copy]'):null;if(!btn)return;var el=d.querySelector(btn.getAttribute('data-copy'));if(!el)return;var text=('value' in el&&el.value!==undefined)?el.value:el.textContent.trim();
if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(text).then(function(){flash(btn)},function(){fallback(el,btn)})}else fallback(el,btn)});
function fallback(el,btn){try{if(el.select){el.select()}else{var r=d.createRange();r.selectNodeContents(el);var s=getSelection();s.removeAllRanges();s.addRange(r)}d.execCommand('copy');flash(btn)}catch(e){}}
$$('[data-select-on-focus]').forEach(function(i){i.addEventListener('focus',function(){i.select()})});

/* Tabs */
$$('[data-tabs]').forEach(function(box){var tabs=$$('[role=tab]',box),key=box.getAttribute('data-remember');
function show(id,save){tabs.forEach(function(t){var on=t.getAttribute('data-tab')===id;t.setAttribute('aria-selected',on?'true':'false');t.tabIndex=on?0:-1;var p=d.getElementById(t.getAttribute('aria-controls'));if(p){if(on)p.removeAttribute('data-inactive');else p.setAttribute('data-inactive','')}});if(save&&key)store('ac-tab-'+key,id)}
tabs.forEach(function(t,i){t.addEventListener('click',function(){show(t.getAttribute('data-tab'),true)});t.addEventListener('keydown',function(e){var k=e.key,j=-1;if(k==='ArrowRight')j=(i+1)%tabs.length;if(k==='ArrowLeft')j=(i-1+tabs.length)%tabs.length;if(j>=0){e.preventDefault();tabs[j].focus();show(tabs[j].getAttribute('data-tab'),true)}})});
var saved=key&&store('ac-tab-'+key);if(saved&&tabs.some(function(t){return t.getAttribute('data-tab')===saved}))show(saved,false);else if(tabs[0])show(tabs[0].getAttribute('data-tab'),false)});

/* Mobile navigation */
function setNav(open){root.classList.toggle('nav-open',open);$$('[data-nav-toggle]').forEach(function(b){b.setAttribute('aria-expanded',open?'true':'false')});
$$('main,footer').forEach(function(el){if(!el.querySelector('.site-nav,.sidebar'))el.inert=open})}
/* Opening moves focus into the menu; tabbing out of it or Escape closes it (Escape returns to the button) */
$$('[data-nav-toggle]').forEach(function(b){b.addEventListener('click',function(e){e.stopPropagation();var open=!root.classList.contains('nav-open');setNav(open);var first=open&&d.querySelector('.site-nav a,.sidebar a');if(first&&first.offsetParent)first.focus()})});
d.addEventListener('focusin',function(e){if(root.classList.contains('nav-open')&&!(e.target.closest&&e.target.closest('.sidebar,.site-nav,[data-nav-toggle]')))setNav(false)});
d.addEventListener('click',function(e){if(!root.classList.contains('nav-open'))return;var nav=e.target.closest&&e.target.closest('.sidebar,.site-nav');if(!nav||e.target.closest('a'))setNav(false)});

/* A side-scrolling strip (doc menu, tabs) on a phone shows its current item, not just the first ones */
$$('.doc-nav,.nav-tabs,.tabs').forEach(function(strip){var cur=strip.querySelector('[aria-current],[aria-selected=true]');if(!cur||strip.scrollWidth<=strip.clientWidth)return;
var s=strip.getBoundingClientRect(),c=cur.getBoundingClientRect();strip.scrollLeft+=c.left-s.left-(s.width-c.width)/2});

/* Header shadow on scroll */
var header=d.querySelector('[data-site-header]');if(header){var onScroll=function(){header.classList.toggle('scrolled',window.scrollY>8)};onScroll();window.addEventListener('scroll',onScroll,{passive:true})}

/* Landing motion (styles/landing.ts): [data-reveal] blocks rise in the first time they scroll into view and
   [data-live] blocks animate only while visible. Blocks already on screen are marked at once without the
   rise, so nothing blinks. Nothing happens with reduced motion; without this script every block simply shows. */
(function(){var els=$$('[data-reveal],[data-live]');if(!els.length||!('IntersectionObserver' in window))return;
if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)return;
/* A block that plays (the hero chat) counts as on screen only when at least half of it shows */
var vh=window.innerHeight,now=els.filter(function(el){var r=el.getBoundingClientRect();return el.getAttribute('data-reveal')==='play'?Math.min(r.bottom,vh)-Math.max(r.top,0)>=Math.min(r.height,vh)*0.5:r.top<vh&&r.bottom>0});
root.classList.add('reveal');
now.forEach(function(el){if(el.hasAttribute('data-reveal'))el.classList.add('in','now');if(el.hasAttribute('data-live'))el.classList.add('live')});
var onSeen=function(es,obs){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');obs.unobserve(e.target)}})};
var seen=new IntersectionObserver(onSeen,{rootMargin:'0px 0px -8% 0px'}),play=new IntersectionObserver(onSeen,{threshold:0.5});
var live=new IntersectionObserver(function(es){es.forEach(function(e){e.target.classList.toggle('live',e.isIntersecting)})});
els.forEach(function(el){if(el.hasAttribute('data-reveal')&&!el.classList.contains('in'))(el.getAttribute('data-reveal')==='play'?play:seen).observe(el);if(el.hasAttribute('data-live'))live.observe(el)})})();

/* Replay: drop the chat's animations for one frame so they start over */
$$('[data-replay]').forEach(function(b){b.addEventListener('click',function(){var box=b.closest('.demo');if(!box)return;box.classList.add('replay');void box.offsetWidth;box.classList.remove('replay')})});

/* On the landing the header links are anchors: the one for the section in view gets aria-current */
(function(){var links=$$('.site-nav a[href^="#"]');if(!links.length||!('IntersectionObserver' in window))return;
var byId={};links.forEach(function(a){var s=d.getElementById(a.getAttribute('href').slice(1));if(s)byId[s.id]=a});
var vis={},spy=new IntersectionObserver(function(es){es.forEach(function(e){vis[e.target.id]=e.isIntersecting});
var cur=Object.keys(byId).filter(function(id){return vis[id]})[0];links.forEach(function(x){if(cur&&byId[cur]===x)x.setAttribute('aria-current','true');else x.removeAttribute('aria-current')})},{rootMargin:'-40% 0px -55% 0px'});
Object.keys(byId).forEach(function(id){spy.observe(d.getElementById(id))})})();

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
d.addEventListener('keydown',function(e){if(e.key!=='Escape')return;menus.forEach(function(m){if(m.open){m.open=false;var s=m.querySelector('summary');if(s)s.focus()}});if(root.classList.contains('nav-open')){setNav(false);var t=$$('[data-nav-toggle]').filter(function(b){return b.offsetParent})[0];if(t)t.focus()}});

/* Live filter: every word typed must appear in an item's data-search. Optional attributes:
   data-filter-expand opens a <details> while searching (and restores it after), data-filter-hide hides a
   block (e.g. a short "popular" row), data-filter-count announces "{n} found" in a live region,
   data-filter-clear shows a clear button, data-filter-enter opens the first match on Enter. Escape
   clears. Items inside a group switched off by category chips (data-chip-off) count as hidden. */
function shown(el){return !el.hidden&&!(el.closest&&el.closest('[data-chip-off]'))}
$$('[data-filter]').forEach(function(input){var box=d.querySelector(input.getAttribute('data-filter'));if(!box)return;
function sel(a){var v=input.getAttribute(a);return v?d.querySelector(v):null}
var expand=sel('data-filter-expand'),hide=sel('data-filter-hide'),count=sel('data-filter-count'),clear=sel('data-filter-clear'),wasOpen=null;
function run(){var q=input.value.trim().toLowerCase(),words=q?q.split(/\\s+/):[];
$$('[data-search]',box).forEach(function(el){var text=el.getAttribute('data-search').toLowerCase();el.hidden=!words.every(function(w){return text.indexOf(w)>=0})});
$$('[data-filter-group]',box).forEach(function(g){g.hidden=$$('[data-search]',g).every(function(el){return el.hidden})});
if(hide)hide.hidden=q!=='';if(clear)clear.hidden=input.value==='';
if(expand){if(q!==''){if(wasOpen===null)wasOpen=expand.open;expand.open=true;expand.setAttribute('data-searching','')}else{expand.removeAttribute('data-searching');if(wasOpen!==null)expand.open=wasOpen;wasOpen=null}}
var n=$$('[data-search]',box).filter(shown).length;
var narrowed=q!==''||$$('[data-chip-off]',box).length>0;if(count)count.textContent=narrowed?(count.getAttribute('data-template')||'{n}').replace('{n}',String(n)):'';
var none=sel('data-filter-empty'),noneChip=sel('data-filter-empty-chip'),byChip=$$('[data-chip-off]',box).length>0;
if(none)none.hidden=n>0||(byChip&&!!noneChip);if(noneChip)noneChip.hidden=n>0||!byChip}
/* Typing searches every category again (a chip picked afterwards narrows the results) */
function changed(){box.dispatchEvent(new Event('filtering'));run()}
input.addEventListener('input',changed);box.addEventListener('chips',run);
if(clear)clear.addEventListener('click',function(){input.value='';changed();input.focus()});
input.addEventListener('keydown',function(e){if(e.key==='Escape'&&input.value){e.preventDefault();input.value='';changed()}
if(e.key==='Enter'&&input.hasAttribute('data-filter-enter')){e.preventDefault();var first=$$('[data-search]',box).filter(shown).map(function(el){return el.querySelector('a.stretch')}).filter(Boolean)[0];if(first)first.click()}})});

/* Category chips: show one category of a list (data-chips="#list", buttons data-chip="<group>", "" for all).
   A row wider than its bar scrolls sideways (touch, trackpad) with arrow buttons at the edges
   (data-chips-prev / data-chips-next next to it) for a mouse. */
$$('[data-chips]').forEach(function(bar){var box=d.querySelector(bar.getAttribute('data-chips'));if(!box)return;bar.hidden=false;var chips=$$('[data-chip]',bar);
function pick(v){chips.forEach(function(x){x.setAttribute('aria-pressed',x.getAttribute('data-chip')===v?'true':'false')});
$$('[data-group]',box).forEach(function(g){if(v&&g.getAttribute('data-group')!==v)g.setAttribute('data-chip-off','');else g.removeAttribute('data-chip-off')})}
function reset(){if($$('[data-chip-off]',box).length){pick('');bar.scrollLeft=0;box.dispatchEvent(new Event('chips'))}}
/* A new search, closing the list or "Search all categories" (data-chips-reset) go back to every category */
box.addEventListener('filtering',function(){if($$('[data-chip-off]',box).length){pick('');bar.scrollLeft=0}});
var det=box.closest('details');if(det)det.addEventListener('toggle',function(){if(!det.open)reset();edge()});
$$('[data-chips-reset]').forEach(function(b){if(d.querySelector(b.getAttribute('data-chips-reset'))!==box)return;b.addEventListener('click',function(){reset();
var f=b.getAttribute('data-focus-after');var to=f&&d.querySelector(f);if(to)to.focus({preventScroll:true})})});
var wrap=bar.parentElement,prev=wrap&&wrap.querySelector('[data-chips-prev]'),next=wrap&&wrap.querySelector('[data-chips-next]');
function edge(){var end=bar.scrollWidth-bar.clientWidth-bar.scrollLeft<=4,start=bar.scrollLeft<=4;bar.classList.toggle('at-end',end);bar.classList.toggle('scrolled',!start);if(next)next.hidden=end;if(prev)prev.hidden=start}
bar.addEventListener('scroll',edge,{passive:true});window.addEventListener('resize',edge);edge();
function page(dir){bar.scrollBy({left:dir*Math.max(120,bar.clientWidth*0.6),behavior:'smooth'})}
if(next)next.addEventListener('click',function(){page(1)});if(prev)prev.addEventListener('click',function(){page(-1)});
/* The picked chip is scrolled clear of the faded edges */
function reveal(c){var r=c.getBoundingClientRect(),b=bar.getBoundingClientRect(),pad=48;if(r.left<b.left+pad)bar.scrollLeft-=b.left+pad-r.left;else if(r.right>b.right-pad)bar.scrollLeft+=r.right-(b.right-pad)}
chips.forEach(function(c){c.addEventListener('click',function(){pick(c.getAttribute('data-chip'));reveal(c);box.dispatchEvent(new Event('chips'));
/* Keep the start of the list right under the (sticky) bar instead of leaving the page scrolled into nothing */
var stick=wrap&&wrap.parentElement||bar,r=box.getBoundingClientRect(),under=stick.getBoundingClientRect().bottom;if(r.top<under)window.scrollBy(0,r.top-under-8)})})});

/* Buttons that close a <details> (e.g. "Show fewer") and bring its top back into view */
$$('[data-collapse]').forEach(function(b){var t=d.querySelector(b.getAttribute('data-collapse'));if(!t)return;b.hidden=false;
b.addEventListener('click',function(){t.open=false;
var h=location.hash&&d.getElementById(location.hash.slice(1));if(h&&t.contains(h)&&history.replaceState)history.replaceState(null,'',location.pathname+location.search);
var s=t.querySelector('summary');if(s){s.focus({preventScroll:true});var r=s.getBoundingClientRect();if(r.top<0||r.bottom>window.innerHeight*0.75)s.scrollIntoView({block:'center'})}})});

/* A <details> opened from its summary: data-focus-on-open="#search" takes keyboard focus there (not
   after a tap, where it would pop up the on-screen keyboard), data-scroll-on-open="#card" brings that
   block's top back into view when the page above it changed (e.g. a popular row hid itself). */
var lastPointer='';d.addEventListener('pointerdown',function(e){lastPointer=e.pointerType||'mouse'},true);d.addEventListener('keydown',function(){lastPointer=''},true);
$$('details[data-focus-on-open],details[data-scroll-on-open]').forEach(function(det){var s=det.querySelector('summary');
function sel(a){var v=det.getAttribute(a);return v?d.querySelector(v):null}
det.addEventListener('toggle',function(){var a=d.activeElement;if(!det.open||det.hasAttribute('data-searching')||!(a===s||!a||a===d.body))return;
var top=sel('data-scroll-on-open');if(top&&top.getBoundingClientRect().top<0)top.scrollIntoView({block:'start'});
var to=sel('data-focus-on-open');if(to&&lastPointer!=='touch'&&lastPointer!=='pen')to.focus({preventScroll:true});else if(s)s.blur()})});

/* A link to a folded section (#custom) or to something inside one (#add-gmail) opens it */
function openTarget(){var id=location.hash.slice(1);if(!id)return;var t=null;try{t=d.getElementById(decodeURIComponent(id))}catch(e){}
var det=t&&(t.tagName==='DETAILS'?t:t.closest('details'));while(det){det.open=true;det=det.parentElement&&det.parentElement.closest('details')}}
openTarget();window.addEventListener('hashchange',openTarget);

/* Filter forms apply as soon as a choice changes (the button stays for keyboards and no-JS) */
/* Delegated, so forms in blocks that live updates replace keep submitting on change. */
d.addEventListener('change',function(e){var f=e.target&&e.target.form;if(f&&f.hasAttribute('data-autosubmit'))f.submit()});

/* Live updates: blocks marked data-poll="<seconds>" (each with an id) refresh from the same address
   while the tab is visible, so a new confirmation or log row shows up without a reload. A block the
   user is working in (focus inside) is left alone until they are done; open <details> stay open. */
(function(){var blocks=$$('[data-poll][id]');if(!blocks.length||!window.fetch||!window.DOMParser)return;
var every=Math.max(3,Math.min.apply(null,blocks.map(function(b){return Number(b.getAttribute('data-poll'))||10})))*1000,busy=false;
function swap(html){var next=new DOMParser().parseFromString(html,'text/html');
$$('[data-poll][id]').forEach(function(b){var fresh=next.getElementById(b.id);if(!fresh||fresh.innerHTML===b.innerHTML)return;var a=d.activeElement;if(a&&b.contains(a)&&/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName))return;
var open=$$('details[id]',b).map(function(x){return [x.id,x.open]});b.innerHTML=fresh.innerHTML;open.forEach(function(o){var x=d.getElementById(o[0]);if(x)x.open=o[1]})})}
function tick(){if(busy||d.hidden)return;busy=true;fetch(location.pathname+location.search,{credentials:'same-origin',headers:{'x-live-update':'1'}}).then(function(r){return r.ok&&!r.redirected?r.text():null}).then(function(html){busy=false;if(html)swap(html)},function(){busy=false})}
setInterval(tick,every);d.addEventListener('visibilitychange',function(){if(!d.hidden)tick()})})();

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
