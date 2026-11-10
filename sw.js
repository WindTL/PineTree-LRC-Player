/* PineTree Lyra v3.2.1 shell cache. Audio/LRC remains in local IndexedDB (unchanged). */
const CACHE='lyra-shell-v321-pinetree-icon-20261109';
const ASSETS=['./','./index.html','./styles.css','./app.js','./manifest.webmanifest','./icon-192.png?v=321','./icon-512.png?v=321','./apple-touch-icon.png?v=321'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter(k=>k.startsWith('lyra-shell-')&&k!==CACHE).map(k=>caches.delete(k)));await self.clients.claim();})());});
self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;const url=new URL(event.request.url);if(url.origin!==self.location.origin)return;event.respondWith((async()=>{const cached=await caches.match(event.request);if(cached)return cached;try{return await fetch(event.request);}catch{if(event.request.mode==='navigate'){const page=await caches.match('./index.html');if(page)return page;}return Response.error();}})());});
