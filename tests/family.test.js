// Headless test for api/family.js. Run: node tests/family.test.js
const path=require('path');let fails=0;const ok=(c,m)=>{console.log(c?'ok':'FAIL',m);if(!c)fails++};
Object.assign(process.env,{FAMILY_PASSWORD:'rock on',SESSION_SECRET:'x'.repeat(40),R2_ACCOUNT_ID:'acct',R2_ACCESS_KEY_ID:'AK',R2_SECRET_ACCESS_KEY:'SK',R2_BUCKET:'band songs',R2_PREFIX:'songs/'});
const h=require(path.join(__dirname,'..','api','family.js'));
// AWS's published presigned-URL example (S3 docs, "Authenticating Requests: Using Query Parameters")
const u=h.presign({host:'examplebucket.s3.amazonaws.com',path:'/test.txt',region:'us-east-1',accessKey:'AKIAIOSFODNN7EXAMPLE',secret:'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',expires:86400,now:new Date('2013-05-24T00:00:00Z')});
ok(u.endsWith('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'),'SigV4 matches AWS reference vector');
const XML=`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>songs/Foo Fighters - Everlong.zip</Key><Size>41000000</Size><ETag>&quot;abc123&quot;</Etag></Contents><Contents><Key>songs/readme.txt</Key><Size>3</Size></Contents><Contents><Key>songs/AC&amp;DC - T.N.T.zip</Key><Size>20000000</Size><ETag>&quot;def&quot;</ETag></Contents></ListBucketResult>`;
let listUrl='';global.fetch=async url=>{listUrl=url;return {ok:true,status:200,text:async()=>XML}};
let jar='';
const run=(method,action,body,extra={})=>new Promise(r=>{const res={c:0,h:{},setHeader(k,v){this.h[k]=v;if(k==='Set-Cookie')jar=v.split(';')[0]},status(c){this.c=c;return this},json(b){r({code:this.c,body:b,headers:this.h})}};
  h({method,query:Object.assign({action},extra.query||{}),body,headers:Object.assign({host:'b.app',origin:'https://b.app',referer:'https://b.app/',cookie:jar},extra.headers||{})},res)});
(async()=>{
 let r=await run('GET','list');ok(r.code===401,'list needs sign-in');
 r=await run('POST','login',{name:'Mum',password:'wrong'});ok(r.code===401,'wrong password rejected');
 r=await run('POST','login',{name:'Mum',password:'rock on'});ok(r.code===200&&/HttpOnly; Secure; SameSite=Strict/.test(r.headers['Set-Cookie']),'sign-in sets secure cookie');
 r=await run('GET','me');ok(r.body.name==='Mum','session read');
 r=await run('GET','list');ok(r.code===200&&r.body.songs.length===2&&r.body.songs[1].key==='songs/AC&DC - T.N.T.zip','zips listed, xml decoded: '+JSON.stringify(r.body.songs.map(s=>s.key)));
 ok(/acct\.r2\.cloudflarestorage\.com\/band%20songs\?/.test(listUrl)&&/prefix=songs%2F/.test(listUrl),'list request targets R2 bucket with prefix');
 r=await run('GET','url',null,{query:{key:'songs/AC&DC - T.N.T.zip'}});ok(/\/band%20songs\/songs\/AC%26DC%20-%20T\.N\.T\.zip\?.*X-Amz-Expires=3600/.test(r.body.url),'signed download link');
 r=await run('GET','url',null,{query:{key:'other/x.zip'}});ok(r.code===400,'keys outside the folder refused');
 const saved=jar;jar=saved.replace(/.$/,c=>c==='A'?'B':'A');r=await run('GET','me');ok(r.code===401,'tampered cookie rejected');jar=saved;
 process.env.FAMILY_PASSWORD='new pass';r=await run('GET','me');ok(r.code===401,'changing password signs everyone out');process.env.FAMILY_PASSWORD='rock on';
 r=await run('GET','me',null,{headers:{origin:'https://evil.com'}});ok(r.code===403,'other sites blocked');
 delete process.env.R2_BUCKET;r=await run('GET','me');ok(r.code===500&&/R2_BUCKET/.test(r.body.error),'missing setting named');
 console.log(fails?fails+' FAILED':'ALL PASS')})();
