/* PineTree v4.3.2 · atomic shell and locally cached Phase 3 art; original IndexedDB untouched. */
const CACHE='lyra-shell-v4320-phase3-20261111';
const ASSETS=[
  './','./index.html','./styles.css?v=4320','./phase3.css?v=4320','./app.js?v=4320',
  './manifest.webmanifest','./icon-192.png?v=4320','./icon-512.png?v=4320',
  './apple-touch-icon.png?v=4320',
  './assets/scene-christmas.webp',
  './assets/scene-newyear.webp',
  './assets/scene-forest.webp',
  './assets/scene-tea.webp',
  './assets/forest-immersive.webp',
  './assets/forest-ultimate-v42.webp',
  './assets/pinecone-thumb-v42.svg',
  './assets/forest-scene-phase2.webp',
  './assets/emerald-facets-phase2.svg',
  './assets/botanical-border-phase2.svg',
  './assets/pine-garland-phase2.svg',
  './assets/phase3/forest-desktop.webp',
  './assets/phase3/forest-mobile.webp',
  './assets/phase3/play.webp',
  './assets/phase3/pause.webp',
  './assets/phase3/prev.webp',
  './assets/phase3/next.webp',
  './assets/phase3/back15.webp',
  './assets/phase3/forward15.webp',
  './assets/phase3/pinecone.webp',
  './assets/phase3/speed.webp',
  './assets/phase3/bookmark.webp',
];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter(k=>k.startsWith('lyra-shell-')&&k!==CACHE).map(k=>caches.delete(k)));await self.clients.claim();})());});
self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;const url=new URL(event.request.url);if(url.origin!==self.location.origin)return;event.respondWith((async()=>{
  if(event.request.mode==='navigate'){
    try{const fresh=await fetch(event.request,{cache:'no-cache'});if(fresh.ok){const shell=await caches.open(CACHE);await shell.put('./index.html',fresh.clone());}return fresh;}
    catch{const offline=await caches.match('./index.html');return offline||Response.error();}
  }
  const cached=await caches.match(event.request);if(cached)return cached;
  try{return await fetch(event.request);}catch{return Response.error();}
})());});
