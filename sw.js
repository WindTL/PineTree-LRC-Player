/* PineTree Lyra v3.8 seasonal themes, flagship themed buttons and accurate centered lyrics, eye-care, cleanup, timer, bookmarks and safe sync shell cache. Audio/LRC remains in local IndexedDB (unchanged). */
const CACHE='lyra-shell-v380-festival-20261110';
const ASSETS=['./','./index.html','./styles.css?v=380','./app.js?v=380','./manifest.webmanifest','./icon-192.png?v=321','./icon-512.png?v=321','./apple-touch-icon.png?v=321'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter(k=>k.startsWith('lyra-shell-')&&k!==CACHE).map(k=>caches.delete(k)));await self.clients.claim();})());});
self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;const url=new URL(event.request.url);if(url.origin!==self.location.origin)return;event.respondWith((async()=>{
  if(event.request.mode==='navigate'){
    try{
      const response=await fetch(event.request,{cache:'no-cache'});
      if(response.ok){const shell=await caches.open(CACHE);await shell.put('./index.html',response.clone());}
      return response;
    }catch{const offline=await caches.match('./index.html');return offline||Response.error();}
  }
  const cached=await caches.match(event.request);if(cached)return cached;
  try{return await fetch(event.request);}catch{return Response.error();}
})());});
