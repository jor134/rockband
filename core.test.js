const fs=require('fs');
const html=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');
const core=html.match(/<script id="core">([\s\S]*?)<\/script>/)[1];
const m={exports:{}};new Function('module',core)(m);const C=m.exports;
let fails=0;const ok=(c,msg)=>{if(!c){fails++;console.log('FAIL',msg)}else console.log('ok',msg)};
// build a MIDI: tempo 120, res 480; PART DRUMS expert kick+red; PART GUITAR expert chord w/ sustain; PART VOCALS note+lyric
const vlq=n=>{const b=[n&0x7f];while(n>>=7)b.unshift((n&0x7f)|0x80);return b};
const trk=evs=>{const d=[];for(const e of evs)d.push(...vlq(e[0]),...e[1]);d.push(0,0xFF,0x2F,0);return [...Buffer.from('MTrk'),0,0,(d.length>>8)&255,d.length&255,...d]};
const name=s=>[0xFF,3,s.length,...Buffer.from(s)];
const t0=trk([[0,[0xFF,0x51,3,0x07,0xA1,0x20]],[960*4,[0xFF,0x51,3,0x03,0xD0,0x90]]]); // 120bpm, then 240bpm at tick 3840
const dr=trk([[0,name('PART DRUMS')],[0,[0x99,96,100]],[0,[97,100]],[120,[0x89,96,0]],[0,[97,0]],[3720+480,[0x99,98,100]],[60,[98,0]]]);
const gt=trk([[0,name('PART GUITAR')],[480,[0x90,96,100]],[0,[98,100]],[960,[0x80,96,0]],[0,[98,0]]]);
const vc=trk([[0,name('PART VOCALS')],[0,[0xFF,5,4,...Buffer.from('Hel-')]],[0,[0x90,64,100]],[0,[105,100]],[240,[0x80,64,0]],[720,[105,0]]]);
const hdr=[...Buffer.from('MThd'),0,0,0,6,0,1,0,4,0x01,0xE0];
const buf=new Uint8Array([...hdr,...t0,...dr,...gt,...vc]).buffer;
const r=C.chartFromMidi(C.parseMidi(buf));
ok(r.parts.drums.expert.length===3,'drums count '+JSON.stringify(r.parts.drums.expert));
ok(Math.abs(r.parts.drums.expert[2].t-4.25)<1e-6,'tempo change handled: '+r.parts.drums.expert[2].t);
const gch=r.parts.guitar.expert[0];ok(gch.lanes.join()==='0,2'&&Math.abs(gch.t-0.5)<1e-6&&Math.abs(gch.end-1.5)<1e-6,'guitar chord+sustain '+JSON.stringify(gch));
ok(r.parts.vocals.notes[0].lyric==='Hel-'&&r.parts.vocals.notes[0].pitch===64&&r.parts.vocals.phrases.length===1,'vocals '+JSON.stringify(r.parts.vocals));
// .chart
const ch=`[Song]\r\n{\r\n  Name = "Test"\r\n  Resolution = 192\r\n  Offset = 0\r\n}\r\n[SyncTrack]\r\n{\r\n  0 = TS 4\r\n  0 = B 120000\r\n}\r\n[ExpertSingle]\r\n{\r\n  192 = N 0 0\r\n  192 = N 1 0\r\n  384 = N 4 192\r\n  384 = S 2 192\r\n}\r\n[ExpertDrums]\r\n{\r\n  0 = N 0 0\r\n  96 = N 5 0\r\n}\r\n`;
const c=C.parseChart(ch);
ok(c.parts.guitar.expert.length===2&&c.parts.guitar.expert[0].lanes.join()==='0,1'&&Math.abs(c.parts.guitar.expert[1].t-1)<1e-6&&c.parts.guitar.expert[1].end>1,'chart guitar '+JSON.stringify(c.parts.guitar.expert));
ok(c.parts.drums.expert[1].lane===4&&Math.abs(c.parts.drums.expert[1].t-0.25)<1e-6,'chart drums');
ok(c.song.Name==='Test','chart song name');
// pitch
for(const f of [110,220,330,523.25]){const sr=48000,b=new Float32Array(2048);for(let i=0;i<b.length;i++)b[i]=0.3*Math.sin(2*Math.PI*f*i/sr)+0.15*Math.sin(4*Math.PI*f*i/sr)+0.08*Math.sin(6*Math.PI*f*i/sr);
  const p=C.detectPitch(b,sr);ok(Math.abs(C.midiOf(p.f)-C.midiOf(f))<0.3,`pitch ${f} -> ${p.f.toFixed(1)}`)}
ok(C.pitchDiff(76,64)===0&&C.pitchDiff(65,64)===1&&Math.abs(C.pitchDiff(63.5,64)+0.5)<1e-9,'octave-agnostic diff');
// mapping: drums with shared pad-flag button
const sets=[[{key:'b4',type:'button'}],[{key:'b2',type:'button'},{key:'b10',type:'button'},{key:'a3:0.5',type:'axis'}],[{key:'b3',type:'button'},{key:'b10',type:'button'}],[{key:'b0',type:'button'},{key:'b10',type:'button'}],[{key:'b1',type:'button'},{key:'b10',type:'button'}]];
const bnd=C.resolveBinds(sets,['kick','red','yellow','blue','green']);
ok(bnd.kick.key==='b4'&&bnd.red.key==='b2'&&bnd.yellow.key==='b3'&&bnd.blue.key==='b0'&&bnd.green.key==='b1','drum flag button eliminated '+JSON.stringify(Object.values(bnd).map(x=>x.key)));
// demo
const d=C.makeDemoChart();
for(const k of ['easy','medium','hard','expert'])console.log(' demo',k,'drums',d.parts.drums[k].length,'guitar',d.parts.guitar[k].length);
ok(d.parts.vocals.notes.length>50&&d.length>60&&d.length<120,'demo len '+d.length.toFixed(1)+'s vocals '+d.parts.vocals.notes.length);
ok(d.parts.guitar.expert.every(n=>n.lanes.every(l=>l>=0&&l<=4)),'guitar lanes valid');
const lanesOk=d.parts.drums.easy.length<d.parts.drums.medium.length&&d.parts.drums.medium.length<d.parts.drums.expert.length;ok(lanesOk,'difficulty scaling');
console.log(fails?fails+' FAILED':'ALL PASS');
