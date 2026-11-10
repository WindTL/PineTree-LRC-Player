/* PineTree v4.2 · versioned atomic app shell; IndexedDB MP3/LRC untouched. */
const CACHE = 'lyra-shell-v4202-forest-ultimate-20261110';
const ASSETS = [
  './', './index.html', './styles.css?v=4202', './app.js?v=4202',
  './manifest.webmanifest', './icon-192.png?v=4202', './icon-512.png?v=4202',
  './apple-touch-icon.png?v=4202', './assets/scene-christmas.webp',
  './assets/scene-newyear.webp', './assets/scene-forest.webp',
  './assets/scene-tea.webp', './assets/forest-immersive.webp',
  './assets/forest-ultimate-v42.webp', './assets/pinecone-thumb-v42.svg'
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
