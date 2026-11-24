'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),vm=require('node:vm'),crypto=require('node:crypto');
const app=fs.readFileSync('app.js','utf8'),html=fs.readFileSync('index.html','utf8'),css=fs.readFileSync('themes/forest-reading/theme.css','utf8');
function extract(name){const a=app.indexOf('function '+name+'('),b=app.indexOf('\nfunction ',a+1);assert(a>=0&&b>a,name);return app.slice(a,b);}
const ctx={};vm.createContext(ctx);vm.runInContext(extract('ptDelta')+'\n'+extract('ptFadeValue')+'\nthis.delta=ptDelta;this.fade=ptFadeValue;',ctx);
const a={id:'x',wall:1000,media:10,rate:2};
assert.equal(ctx.delta(a,{id:'x',wall:2000,media:12,rate:2}),1);
assert.equal(ctx.delta(a,{id:'x',wall:2000,media:10,rate:2}),0);
assert.equal(ctx.delta(a,{id:'y',wall:2000,media:12,rate:2}),0);
assert.equal(ctx.delta(a,{id:'x',wall:35000,media:80,rate:2}),0);
assert.equal(ctx.fade(.8,60000),.8);assert.equal(ctx.fade(.8,30000),.4);assert.equal(ctx.fade(.8,0),0);
for(const id of ['ptEco','ptDepth','ptFade','ptToday','ptChapters','ptStreak','ptWeek'])assert.equal(html.split('id="'+id+'"').length-1,1,id);
assert(app.includes('skipSeconds(-Number(e.dataset.ptRewind))'));
assert(css.includes('prefers-reduced-motion:reduce'));assert(css.includes('data-page-visible="false"'));assert(css.includes('ptLake'));assert(css.includes('ptHop'));
const manifest=JSON.parse(fs.readFileSync('version.json','utf8'));
for(const [p,h] of Object.entries(manifest.files))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),h,p);
console.log('PASS Living Forest statistics, fade, controls, animation guards and complete release hashes');
