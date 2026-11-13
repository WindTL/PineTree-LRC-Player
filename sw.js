/* PineTree 4.4.1 - verified, scope-specific shell. Never touches IndexedDB. */
'use strict';
const VERSION='4401', SCOPE=new URL(self.registration.scope), PREFIX='pinetree-shell-'+encodeURIComponent(SCOPE.pathname)+'-', CACHE=PREFIX+VERSION;
const absolute=p=>new URL(p,SCOPE).href;
function safe(p){if(typeof p!=='string'||!p||p.startsWith('/')||p.includes('..')||p.includes('\\')||p.includes('#')||/^[a-z]+:/i.test(p))throw Error('invalid path');const u=new URL(p,SCOPE);if(u.origin!==SCOPE.origin||!u.pathname.startsWith(SCOPE.pathname))throw Error('outside scope');return u;}
async function fresh(p,nonce){const u=safe(p);u.searchParams.set('pt_refresh',nonce);const r=await fetch(u.href,{cache:'no-store',credentials:'same-origin'});if(!r.ok)throw Error(p+' HTTP '+r.status);return r;}
async function hash(b){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join('');}
async function installShell(){const nonce=Date.now().toString(36);const m=await (await fresh('version.json',nonce)).json();if(m.format!=='pinetree-shell-v1'||m.version!==VERSION||!m.files?.['index.html']||!m.files?.['app.js']||!m.files?.['sw.js'])throw Error('release mismatch');const entries=Object.entries(m.files);if(entries.length>300)throw Error('manifest too large');const verified=[];for(let i=0;i<entries.length;i+=6){verified.push(...await Promise.all(entries.slice(i,i+6).map(async([p,h])=>{if(!/^[a-f0-9]{64}$/.test(h))throw Error('invalid hash');const r=await fresh(p,nonce),b=await r.arrayBuffer();if(await hash(b)!==h)throw Error('hash mismatch '+p);return [absolute(p),new Response(b,{headers:{'Content-Type':r.headers.get('Content-Type')||'application/octet-stream'}})];})));}const c=await caches.open(CACHE);for(const [url,r]of verified)await c.put(url,r);await c.put(absolute('./'),(await c.match(absolute('index.html'))).clone());}
self.addEventListener('install',event=>event.waitUntil(installShell().then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('message',event=>{if(event.data?.type==='PINETREE_VERSION')event.ports[0]?.postMessage({version:VERSION});});
self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;const u=new URL(event.request.url);if(u.origin!==SCOPE.origin||!u.pathname.startsWith(SCOPE.pathname))return;
 // Explicit version and repair requests always go to the network, never a stale shell cache.
 if(u.searchParams.has('pt_refresh')||u.pathname===new URL('version.json',SCOPE).pathname||u.pathname===new URL('repair.html',SCOPE).pathname){event.respondWith(fetch(event.request,{cache:'no-store'}));return;}
 event.respondWith((async()=>{const c=await caches.open(CACHE);if(event.request.mode==='navigate'&&(u.pathname===SCOPE.pathname||u.pathname===new URL('index.html',SCOPE).pathname)){const shell=await c.match(absolute('index.html'));if(shell)return shell;return fetch(event.request,{cache:'no-store'});}const hit=await c.match(event.request,{ignoreSearch:true});if(hit)return hit;return fetch(event.request);})());
});
