// Headless test for api/rv-search.js with a mocked Parse response. Run: node tests/api.test.js
const path=require('path');let fails=0;const ok=(c,m)=>{console.log(c?'ok':'FAIL',m);if(!c)fails++};
const sample={status:'success',data:{page:'1',returned:2,total_filtered:214,songs:[
 {title:'Kit Guitar Song',artist:'Pete Cottrell',gameformat:'ch',diff_guitar:'3',diff_bass:'3',diff_drums:'4',diff_vocals:null,song_length:194,downloads:11,author_name:'jack',download_page_url:'https://rhythmverse.co/download/fe7f'},
 {title:'Evil',artist:'X',gameformat:'rb3',download_page_url:'https://evil.example.com/x'}]}};
let sent=null,calls=0;
global.fetch=async(url,o)=>{calls++;sent=JSON.parse(o.body);ok(o.headers['X-API-Key']==='k','key sent as header');return {ok:true,status:200,json:async()=>sample}};
const h=require(path.join(__dirname,'..','api','rv-search.js'));
const run=(req)=>new Promise(r=>{const res={code:0,headers:{},setHeader(){},status(c){this.code=c;return this},json(b){r({code:this.code,body:b})}};h(req,res)});
const req=(b,hd={})=>({method:'POST',body:b,headers:Object.assign({host:'backlit.vercel.app',origin:'https://backlit.vercel.app','x-forwarded-for':'1.2.3.4'},hd)});
(async()=>{
 process.env.PARSE_API_KEY='';let r=await run(req({query:'a'}));ok(r.code===500,'missing key reported');
 process.env.PARSE_API_KEY='k';
 r=await run(req({query:'a'},{origin:'https://evil.com'}));ok(r.code===403,'cross-site blocked');
 r=await run(req({query:'  metallica '}));ok(r.code===200&&r.body.songs.length===2&&r.body.total===214,'search ok');
 ok(sent.query==='metallica'&&sent.records==='25'&&!sent.artist,'payload trimmed');
 ok(r.body.songs[0].diffs.drums===4&&r.body.songs[0].diffs.vocals===null&&r.body.songs[0].format==='ch','fields normalized');
 ok(r.body.songs[1].page_url==='','non-rhythmverse link stripped');
 const before=calls;r=await run(req({query:'METALLICA'}));ok(calls===before,'cached repeat costs no credit');
 r=await run(req({query:''}));ok(sent.sort_by==='downloads'&&!sent.query,'empty query = most downloaded');
 for(let i=0;i<8;i++)await run(req({query:'q'+i}));r=await run(req({query:'zz'}));ok(r.code===429,'per-visitor limit');
 r=await run({method:'GET',headers:{}});ok(r.code===405,'GET rejected');
 console.log(fails?fails+' FAILED':'ALL PASS')})();
