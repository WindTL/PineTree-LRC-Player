/* PineTree v4.3.3 · atomic shell and locally cached Phase 3 art; original IndexedDB untouched. */
const CACHE='lyra-shell-v4330-scoped-forest';
const ASSETS=[
  './','./index.html','./styles.css?v=4330','./themes/forest-reading/theme.css?v=4330','./app.js?v=4330',
  './manifest.webmanifest','./icon-192.png?v=4330','./icon-512.png?v=4330',
  './apple-touch-icon.png?v=4330',
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
  './themes/forest-reading/assets/forest-desktop.webp',
  './themes/forest-reading/assets/forest-mobile.webp',
  './themes/forest-reading/assets/play.webp',
  './themes/forest-reading/assets/pause.webp',
  './themes/forest-reading/assets/prev.webp',
  './themes/forest-reading/assets/next.webp',
  './themes/forest-reading/assets/back15.webp',
  './themes/forest-reading/assets/forward15.webp',
  './themes/forest-reading/assets/pinecone.webp',
  './themes/forest-reading/assets/speed.webp',
  './themes/forest-reading/assets/bookmark.webp',
  './themes/forest-reading/assets/squirrel-running.webp',
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
