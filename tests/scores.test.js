// Headless test for api/scores.js against a tiny in-memory Redis. Run: node tests/scores.test.js
const path=require('path');let fails=0;const ok=(c,m)=>{console.log(c?'ok':'FAIL',m);if(!c)fails++};
const db={z:new Map(),h:new Map(),k:new Map()};
function exec(c){const [cmd,...a]=c;const z=k=>db.z.get(k)||(db.z.set(k,[]),db.z.get(k));const sorted=k=>z(k).slice().sort((x,y)=>x.s-y.s||x.m.localeCompare(y.m));
  switch(cmd){case 'HSET':{const h=db.h.get(a[0])||new Map();h.set(a[1],a[2]);db.h.set(a[0],h);return 1}
  case 'HGETALL':return [...(db.h.get(a[0])||new Map())].flat();
  case 'INCR':{const v=(db.k.get(a[0])||0)+1;db.k.set(a[0],v);return v}case 'EXPIRE':return 1;
  case 'ZADD':{z(a[0]).push({s:+a[1],m:a[2]});return 1}
  case 'ZREMRANGEBYRANK':{const s=sorted(a[0]);let st=+a[1],en=+a[2];if(en<0)en=s.length+en;const keep=s.filter((_,i)=>i<st||i>en);db.z.set(a[0],keep);return s.length-keep.length}
  case 'ZREVRANK':{const s=sorted(a[0]).reverse();const i=s.findIndex(x=>x.m===a[1]);return i<0?null:i}
  case 'ZREVRANGE':{const s=sorted(a[0]).reverse().slice(+a[1],+a[2]+1);return s.flatMap(x=>[x.m,String(x.s)])}}
  throw new Error('unknown '+cmd)}
global.fetch=async(url,o)=>{ok(url.endsWith('/pipeline')&&o.headers.Authorization==='Bearer t','pipeline auth');return {ok:true,status:200,json:async()=>JSON.parse(o.body).map(c=>({result:exec(c)}))}};
process.env.KV_REST_API_URL='https://x.upstash.io/';process.env.KV_REST_API_TOKEN='t';
const h=require(path.join(__dirname,'..','api','scores.js'));
const run=req=>new Promise(r=>{const res={code:0,setHeader(){},status(c){this.code=c;return this},json(b){r({code:this.code,body:b})}};h(req,res)});
const hd={host:'b.app',origin:'https://b.app',referer:'https://b.app/','x-forwarded-for':'9.9.9.9'};
const post=b=>run({method:'POST',headers:hd,body:b});
const song={id:'foo-fighters-everlong-abc12',title:'Everlong',artist:'Foo Fighters'};
(async()=>{
 let r=await post({song,name:'Jordan',entries:[{part:'drums',diff:'expert',score:9000,hits:90,total:100,streak:50},{part:'vocals',diff:'medium',score:3000,hits:20,total:30,streak:10}]});
 ok(r.code===200&&r.body.ranks[0].rank===1&&r.body.ranks[1].rank===1,'post two parts, both #1');
 r=await post({song,name:'Sam <b>',entries:[{part:'drums',diff:'expert',score:12000,hits:95,total:100,streak:60}]});ok(r.body.ranks[0].rank===1,'higher score takes #1');
 r=await post({song,name:'Cheat',entries:[{part:'drums',diff:'expert',score:999999,hits:100,total:100,streak:100}]});ok(r.code===400,'impossible score rejected');
 r=await post({song,name:'   ',entries:[{part:'drums',diff:'expert',score:1,hits:1,total:100,streak:1}]});ok(r.code===400,'blank name rejected');
 r=await run({method:'GET',headers:hd,query:{song:song.id,part:'drums',diff:'expert'}});
 ok(r.body.rows.length===2&&r.body.rows[0].name==='Sam b'&&r.body.rows[0].score===12000&&r.body.rows[1].acc===90,'top list ordered, name cleaned: '+JSON.stringify(r.body.rows.map(x=>x.name)));
 r=await run({method:'GET',headers:hd,query:{list:'songs'}});ok(r.body.songs.length===1&&r.body.songs[0].title==='Everlong','song list');
 for(let i=0;i<105;i++){db.k.clear();await post({song,name:'P'+i,entries:[{part:'guitar',diff:'easy',score:100+i,hits:1,total:100,streak:1}]})}
 ok(db.z.get('bl:lb:'+song.id+':guitar:easy').length===100,'board trimmed to 100');
 db.k.clear();r=await post({song,name:'Low',entries:[{part:'guitar',diff:'easy',score:1,hits:1,total:100,streak:1}]});ok(r.body.ranks[0].rank===null,'outside top 100 reported');
 r=await run({method:'POST',headers:Object.assign({},hd,{origin:'https://evil.com'}),body:{}});ok(r.code===403,'cross-site blocked');
 db.k.set('bl:rl:9.9.9.9',30);r=await post({song,name:'X',entries:[{part:'bass',diff:'easy',score:10,hits:1,total:10,streak:1}]});ok(r.code===429,'post rate limit');
 r=await run({method:'GET',headers:hd,query:{song:'../x',part:'drums',diff:'expert'}});ok(r.code===400,'bad song id rejected');
 delete process.env.KV_REST_API_URL;delete process.env.KV_REST_API_TOKEN;
 process.env.STORAGE_KV_REST_API_URL='https://y.upstash.io';process.env.STORAGE_KV_REST_API_TOKEN='t';
 r=await run({method:'GET',headers:hd,query:{list:'songs'}});ok(r.code===200,'custom-prefix Vercel names work');
 delete process.env.STORAGE_KV_REST_API_URL;delete process.env.STORAGE_KV_REST_API_TOKEN;process.env.REDIS_URL='redis://secret@host:6379';
 r=await run({method:'GET',headers:hd,query:{list:'songs'}});ok(r.code===500&&/REDIS_URL/.test(r.body.error)&&!/secret/.test(r.body.error),'TCP-only Redis explained, no secrets leaked: '+r.body.error);
 delete process.env.REDIS_URL;r=await run({method:'GET',headers:hd,query:{list:'songs'}});ok(/no database variables/.test(r.body.error),'nothing connected explained');
 console.log(fails?fails+' FAILED':'ALL PASS')})();
