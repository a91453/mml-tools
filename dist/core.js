export const VERSION = '0.1.0';
export const PROFILE = 'mobile-strict-2026-09-08';
export const ROLES = ['Melody','Chord1','Chord2','Chord3','Chord4','Chord5'];
export const COLORS = ['#70e2d0','#b4a0ff','#f5c478','#6cbbff','#f695b4','#b8d87c'];
const gcd=(a,b)=>{a=a<0n?-a:a;b=b<0n?-b:b;while(b){[a,b]=[b,a%b]}return a||1n};
export class F {
  constructor(n=0,d=1){if(n instanceof F){this.n=n.n;this.d=n.d;return}if(typeof n==='string'&&n.includes('/')){const a=n.split('/');if(a.length!==2)throw Error('分數格式錯誤');n=BigInt(a[0]);d=BigInt(a[1])}else if(typeof n==='string'&&n.includes('.')){if(!/^-?\d+\.\d{1,9}$/.test(n))throw Error('小數最多9位');const [a,b]=n.split('.');n=BigInt(a+b);d=10n**BigInt(b.length)}else{n=BigInt(n);d=BigInt(d)}if(!d)throw Error('分母不可為0');if(d<0n){n=-n;d=-d}const g=gcd(n,d);this.n=n/g;this.d=d/g}
  add(x){x=f(x);return new F(this.n*x.d+x.n*this.d,this.d*x.d)} sub(x){x=f(x);return new F(this.n*x.d-x.n*this.d,this.d*x.d)} mul(x){x=f(x);return new F(this.n*x.n,this.d*x.d)} div(x){x=f(x);return new F(this.n*x.d,this.d*x.n)} cmp(x){x=f(x);const a=this.n*x.d-x.n*this.d;return a<0n?-1:a>0n?1:0} num(){return Number(this.n)/Number(this.d)} toString(){return this.d===1n?String(this.n):`${this.n}/${this.d}`} toJSON(){return this.toString()}
}
export const f=x=>x instanceof F?x:new F(x);
const min=(a,b)=>f(a).cmp(b)<=0?f(a):f(b);
const max=(a,b)=>f(a).cmp(b)>=0?f(a):f(b);
const eq=(a,b)=>f(a).cmp(b)===0;
const noteBase={c:0,d:2,e:4,f:5,g:7,a:9,b:11};
const allowedLengths=new Set([1,2,3,4,6,8,12,16,24,32]);
export function splitMML(raw){if(typeof raw!=='string'||raw.length>40000)throw Error('請提供40,000字以內的MML');const s=raw.trim();if(!/^MML@/i.test(s)||!s.endsWith(';'))throw Error('請貼上從 MML@ 到 ; 的完整六軌字串');const tracks=s.slice(4,-1).split(',');if(tracks.length!==6)throw Error(`需要六個固定軌位，目前為${tracks.length}軌`);return tracks}
function controlsPush(list,event){const last=list.at(-1);if(last&&eq(last.beat,event.beat))list[list.length-1]=event;else if(!last||last.value!==event.value)list.push(event)}
export function parseTrack(raw,role){
  const errors=[],events=[],tempo=[],controls=[{beat:'0',controller:7,value:8}];
  const fail=(message,pos)=>errors.push({role,position:pos+1,message});
  if(raw.length>2400)fail(`字數${raw.length}，超過2400上限`,0);
  if(/\s/.test(raw))fail('軌內含空白或換行，請保留純MML字串',raw.search(/\s/));
  let i=0,time=f(0),octave=4,explicitOctave=false,length=4,volume=8,pending=false,lastWasNote=false;
  const s=raw.toLowerCase();
  while(i<s.length){const start=i,ch=s[i++];if(/\s/.test(ch))continue;
    if('tolv'.includes(ch)){
      const m=/^\d+/.exec(s.slice(i));if(!m){fail(`${ch.toUpperCase()}缺少數值`,start);continue}i+=m[0].length;const n=Number(m[0]);
      if(ch==='t'){if(n<32||n>320)fail(`T${n}超出32–320`,start);if(tempo.length&&f(tempo.at(-1).beat).cmp(time)>=0)fail('同一拍重複或倒序Tempo',start);tempo.push({beat:String(time),bpm:n})}
      if(ch==='o'){octave=n;explicitOctave=true;if(n<0||n>8)fail(`O${n}超出0–8`,start)}
      if(ch==='l'){length=n;if(!allowedLengths.has(n))fail(`Strict Mobile不接受L${n}`,start)}
      if(ch==='v'){if(n<0||n>15)fail(`V${n}超出0–15`,start);else{volume=n;controlsPush(controls,{beat:String(time),controller:7,value:n})}}
      continue;
    }
    if(ch==='<'||ch==='>'){octave+=ch==='>'?1:-1;if(octave<0||octave>8)fail('八度超出O0–O8',start);continue}
    if(ch==='&'){if(pending||!lastWasNote||!events.length||!eq(events.at(-1).end,time))fail('延音必須接續同音音符，不能接休止或重複 &',start);pending=true;continue}
    if(ch==='n'){const m=/^\d+/.exec(s.slice(i));if(m)i+=m[0].length;fail('Nxx的編號方言未驗證，請改用音名與明確八度',start);pending=false;continue}
    if(ch in noteBase||ch==='r'){
      let accidental=0;if(ch!=='r'&&['+','#','-'].includes(s[i])){accidental=s[i]==='-'?-1:1;i++}
      const m=/^\d+/.exec(s.slice(i));let den=m?Number(m[0]):length;if(m)i+=m[0].length;
      let dots=0;while(s[i]==='.'){dots++;i++}
      if(!allowedLengths.has(den))fail(`Strict Mobile不接受${ch}${den}；48／64與更細時值不可直接交付`,start);
      if(dots>1)fail('不接受雙附點／多附點',start);
      if(dots&&[3,6,12,24,48].includes(den))fail(`不接受附點三連音式時值${den}.，需等值正規化`,start);
      if(!Number.isSafeInteger(den)||den<=0){fail('時值分母必須為正整數',start);den=4}
      const duration=new F(4,den).mul(dots?new F(2n**BigInt(Math.min(dots,8)+1)-1n,2n**BigInt(Math.min(dots,8))):1);
      const end=time.add(duration);
      if(ch==='r'){if(pending)fail('延音不能接到休止',start);pending=false;lastWasNote=false}
      else{
        if(!explicitOctave)fail('首音前必須明確設定O八度',start);
        const pitch=12*(octave+1)+noteBase[ch]+accidental;if(pitch<0||pitch>127)fail('音高超出MIDI 0–127',start);
        if(pending&&events.length&&events.at(-1).pitch===pitch&&eq(events.at(-1).end,time))events.at(-1).end=String(end);
        else{if(pending)fail('延音音高不同或跨越空隙',start);events.push({pitch,start:String(time),end:String(end),volume})}
        pending=false;lastWasNote=true;
      }time=end;continue;
    }
    fail(`無法辨識字元「${ch}」`,start);pending=false;
  }
  if(pending)fail('軌尾有未完成延音',Math.max(0,s.length-1));
  if(raw&&(!tempo.length||!eq(tempo[0].beat,0)))fail('非空軌必須在第0拍設定Tempo',0);
  return {role,raw,characters:raw.length,total:String(time),events,controls,tempo,errors,empty:raw.length===0};
}
export function parseMeter(text){const lines=text.trim().split(/\n/).filter(x=>x.trim());if(!lines.length)throw Error('請指定拍號圖');return lines.map((line,index)=>{const m=/^\s*(\d+(?:\/\d+|\.\d+)?)\s+(\d+)\/(\d+)\s*$/.exec(line);if(!m)throw Error(`拍號圖第${index+1}行應為「起拍 拍號」`);const beat=f(m[1]),numerator=Number(m[2]),denominator=Number(m[3]);if(numerator<1||numerator>255||denominator<1||denominator>128||(denominator&(denominator-1)))throw Error('拍號分母需為1–128的2次方，分子1–255');return {beat:String(beat),numerator,denominator}})}
export function buildBars(total,meter,pickup='',finalPartial=''){
  total=f(total);if(total.cmp(0)<=0)throw Error('樂曲需有正拍長');if(!meter.length||!eq(meter[0].beat,0))throw Error('拍號圖必須从第0拍開始');
  for(let i=0;i<meter.length;i++){if(f(meter[i].beat).cmp(total)>=0)throw Error('拍號切換需位於樂曲結束之前');if(i&&f(meter[i-1].beat).cmp(meter[i].beat)>=0)throw Error('拍號位置必須依序且不可重複')}
  const pickupLen=pickup?f(pickup):null,partial=finalPartial?f(finalPartial):null;
  if(pickupLen&&pickupLen.cmp(0)<=0||partial&&partial.cmp(0)<=0)throw Error('弱起及末小節需為正拍長');
  const bars=[];let cursor=f(0),mi=0,usedPartial=false;
  while(cursor.cmp(total)<0){if(bars.length>=10000)throw Error('小節數超出10,000上限');if(mi+1<meter.length&&eq(cursor,meter[mi+1].beat))mi++;
    const sig=meter[mi],full=new F(sig.numerator*4,sig.denominator);let size=bars.length===0&&pickupLen?pickupLen:full;
    if(bars.length===0&&pickupLen&&pickupLen.cmp(full)>=0)throw Error('弱起需短於第一小節拍號');
    const remain=total.sub(cursor);if(size.cmp(remain)>0){if(!partial||!eq(partial,remain)||partial.cmp(full)>=0)throw Error(`末小節剩${remain}拍，請依來源明確填寫末小節長度`);size=remain;usedPartial=true}
    if(mi+1<meter.length&&f(meter[mi+1].beat).cmp(cursor.add(size))<0)throw Error(`第${meter[mi+1].beat}拍變拍落在小節內；請核對來源或弱起`);
    bars.push({index:bars.length+1,start:String(cursor),end:String(cursor.add(size)),numerator:sig.numerator,denominator:sig.denominator,partial:!eq(size,full)});cursor=cursor.add(size);
  }if(partial&&!usedPartial)throw Error('末小節長度設定與實際結尾不符');return bars;
}
export function normalizeProfile(text){if(!text?.trim())return null;const p=JSON.parse(text);if(!ROLES.includes(p.role)||!p.instrument?.trim()||!p.evidence?.trim()||!p.mapping||Array.isArray(p.mapping)||!Object.keys(p.mapping).length)throw Error('鼓面表需要role、instrument、evidence與非空mapping');for(const [key,val] of Object.entries(p.mapping))if(!/^\d+$/.test(key)||Number(key)>127||!Number.isInteger(val)||val<0||val>127)throw Error('鼓面對應需使用0–127整數音位');return p}
export function validateMML(raw,settings={}){
  const errors=[],warnings=[];let strings;try{strings=splitMML(raw)}catch(e){return {ok:false,errors:[{message:e.message}],warnings}}
  const tracks=strings.map((s,i)=>parseTrack(s,ROLES[i]));errors.push(...tracks.flatMap(t=>t.errors));const active=tracks.filter(t=>!t.empty);let tempo=[],total='0',meter=[],bars=[],drums=null;
  if(!active.length)errors.push({message:'六軌皆空，無法建立預覽'});
  if(active.length){tempo=active[0].tempo;total=active[0].total;for(const t of active){if(!eq(t.total,total))errors.push({role:t.role,message:`總拍長${t.total}不等於${total}`});if(JSON.stringify(t.tempo)!==JSON.stringify(tempo))errors.push({role:t.role,message:'Tempo Map與其他非空軌不同'})}}
  try{meter=parseMeter(settings.meterText||'0 4/4');bars=buildBars(total,meter,settings.pickup,settings.finalPartial)}catch(e){errors.push({message:e.message})}
  try{drums=normalizeProfile(settings.drumText);if(drums){const t=tracks[ROLES.indexOf(drums.role)];for(const e of t.events)if(!(String(e.pitch) in drums.mapping))throw Error(`${drums.role}缺少Mobile音位${e.pitch}的鼓面對應`)}}catch(e){errors.push({message:e.message})}
  const programs=ROLES.map((r,i)=>Number(settings.programs?.[i]??0));if(programs.some(p=>!Number.isInteger(p)||p<0||p>127))errors.push({message:'MIDI Program需為0–127整數'});
  const song={version:VERSION,profile:PROFILE,title:settings.title||'未命名樂譜',tracks,tempo,total,meter,bars,drums,programs};
  if(!errors.length){const review=reviewSong(song);warnings.push(...review.summary);song.review=review;return {ok:true,errors,warnings,song}}
  return {ok:false,errors,warnings,song};
}
export function secondsAt(beat,tempo){const b=f(beat);let seconds=0;for(let i=0;i<tempo.length;i++){const start=f(tempo[i].beat);if(start.cmp(b)>=0)break;const end=i+1<tempo.length?min(b,tempo[i+1].beat):b;seconds+=end.sub(start).num()*60/Number(tempo[i].bpm)}return seconds}
export function beatAtSeconds(seconds,tempo,total){let remaining=Math.max(0,seconds);for(let i=0;i<tempo.length;i++){const start=f(tempo[i].beat).num(),end=f(i+1<tempo.length?tempo[i+1].beat:total).num(),span=(end-start)*60/Number(tempo[i].bpm);if(remaining<=span)return start+remaining*Number(tempo[i].bpm)/60;remaining-=span}return f(total).num()}
export function reviewSong(song){const pairs=[],crowding=[];for(let i=0;i<6;i++)for(let j=i+1;j<6;j++){const overlaps=[];const a=song.tracks[i],b=song.tracks[j];if(song.drums?.role===a.role||song.drums?.role===b.role){pairs.push({left:a.role,right:b.role,status:'percussion_not_pitched',overlaps});continue}let k=0;for(const x of a.events){while(k<b.events.length&&f(b.events[k].end).cmp(x.start)<=0)k++;for(let z=k;z<b.events.length&&f(b.events[z].start).cmp(x.end)<0;z++){const y=b.events[z],start=String(max(x.start,y.start)),end=String(min(x.end,y.end));if(eq(start,end))continue;if(x.pitch===y.pitch)overlaps.push({pitch:x.pitch,start,end,kind:eq(x.start,y.start)&&eq(x.end,y.end)?'exact':'sustained'});const gap=Math.abs(x.pitch-y.pitch);if((gap===1||gap===11)&&Math.min(x.pitch,y.pitch)<60)crowding.push({left:a.role,right:b.role,pitches:[x.pitch,y.pitch],start,end})}}pairs.push({left:a.role,right:b.role,status:'reviewed_intervals',overlaps})}
  const sum=pairs.reduce((n,p)=>n+p.overlaps.length,0),summary=[];if(sum)summary.push(`${sum}組持續同音重疊，需依角色與來源審核，非自動刪音`);if(crowding.length)summary.push(`${crowding.length}處低中音小二度／大七度，需聽驗解決`);
  const onsets={};for(const t of song.tracks)for(const e of t.events)onsets[e.start]=(onsets[e.start]||0)+1;
  return {pairs,crowding,maxSimultaneousAttacks:Math.max(0,...Object.values(onsets)),summary};
}
export function canonicalControls(track){return track.controls.map(c=>({beat:c.beat,controller:7,value:Math.round(c.value*127/15)}))}
export function expectedMidi(song){return {tempo:song.tempo.map(t=>({beat:t.beat,microseconds:Math.round(60000000/t.bpm)})),meter:song.meter,total:song.total,tracks:[{role:'Conductor',channel:null,program:null,events:[],controls:[]},...song.tracks.map((t,i)=>({role:t.role,channel:song.drums?.role===t.role?9:i,program:song.drums?.role===t.role?null:song.programs[i],events:t.events.map(e=>({pitch:song.drums?.role===t.role?song.drums.mapping[e.pitch]:e.pitch,start:e.start,end:e.end,velocity:100})),controls:canonicalControls(t)}))]}}
const encoder=new TextEncoder();
function vlq(x){x=Number(x);if(!Number.isSafeInteger(x)||x<0||x>0xfffffff)throw Error('MIDI間隔超出可編碼範圍');const a=[x&127];while((x=Math.floor(x/128)))a.unshift(128|(x&127));return a}
const u16=n=>[(n>>8)&255,n&255],u32=n=>[(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255];
export function writeMidi(song){const model=expectedMidi(song);let ppq=480n;const times=[model.total,...model.tempo.map(x=>x.beat),...model.meter.map(x=>x.beat),...model.tracks.flatMap(t=>[...t.events.flatMap(e=>[e.start,e.end]),...t.controls.map(c=>c.beat)])];for(const t of times)ppq=ppq/gcd(ppq,f(t).d)*f(t).d;if(ppq>32767n)throw Error('精確時值超出MIDI PPQ上限，未自動近似');
  const chunks=[];for(const t of model.tracks){const list=[];const push=(beat,order,data)=>list.push({tick:Number(f(beat).mul(new F(ppq)).n),order,data});
    const name=[...encoder.encode(t.role)];push(0,-10,[255,3,...vlq(name.length),...name]);
    if(t.role==='Conductor'){for(const m of model.meter)push(m.beat,-2,[255,88,4,m.numerator,Math.log2(m.denominator),24,8]);for(const x of model.tempo)push(x.beat,-1,[255,81,3,(x.microseconds>>16)&255,(x.microseconds>>8)&255,x.microseconds&255])}
    else{if(t.program!==null)push(0,-5,[192|t.channel,t.program]);for(const c of t.controls)push(c.beat,-3,[176|t.channel,c.controller,c.value]);for(const e of t.events){push(e.start,1,[144|t.channel,e.pitch,e.velocity]);push(e.end,-4,[128|t.channel,e.pitch,0])}}
    push(model.total,10,[255,47,0]);list.sort((a,b)=>a.tick-b.tick||a.order-b.order);let tick=0;const data=[];for(const e of list){data.push(...vlq(e.tick-tick),...e.data);tick=e.tick}chunks.push([77,84,114,107,...u32(data.length),...data]);
  }return new Uint8Array([77,84,104,100,0,0,0,6,...u16(1),...u16(7),...u16(Number(ppq)),...chunks.flat()]);
}
export function readMidi(bytes){
  if(!(bytes instanceof Uint8Array))bytes=new Uint8Array(bytes);let p=0;const take=n=>{if(p+n>bytes.length)throw Error('MIDI資料截斷');const b=bytes.slice(p,p+n);p+=n;return b};const byte=()=>take(1)[0];const num=n=>[...take(n)].reduce((a,b)=>a*256+b,0);const str=n=>new TextDecoder().decode(take(n));const varnum=()=>{let n=0;for(let i=0;i<4;i++){const b=byte();n=n*128+(b&127);if(b<128)return n}throw Error('MIDI可變長數值無效')};
  if(str(4)!=='MThd'||num(4)!==6)throw Error('無效MIDI標頭');const format=num(2),count=num(2),ppq=num(2);if(format!==1||count!==7||!ppq||ppq>32767)throw Error('需Type 1、7軌與PPQ時間');const tempo=[],meter=[],tracks=[],totals=[];
  for(let ti=0;ti<count;ti++){if(str(4)!=='MTrk')throw Error('缺少MIDI軌');const len=num(4),end=p+len;if(end>bytes.length)throw Error('MIDI軌截斷');let tick=0,running=0,eot=false;const track={role:'',channel:null,program:null,events:[],controls:[]},active=new Map(),channelSet=new Set();
    while(p<end){tick+=varnum();let status=byte();if(status<128){if(!running)throw Error('無效running status');p--;status=running}const beat=String(new F(tick,ppq));
      if(status===255){running=0;const kind=byte(),n=varnum(),body=take(n);if(kind===3){const role=new TextDecoder().decode(body);if(track.role&&track.role!==role)throw Error('軌名衝突');track.role=role}
        else if(kind===81){if(ti||n!==3)throw Error('Tempo需在Conductor');const us=body[0]*65536+body[1]*256+body[2];if(!us)throw Error('Tempo不可為0');tempo.push({beat,microseconds:us})}
        else if(kind===88){if(ti||n!==4||body[1]>7||!body[0])throw Error('拍號需在Conductor且格式正確');meter.push({beat,numerator:body[0],denominator:2**body[1]})}
        else if(kind===47){if(n||p!==end)throw Error('MIDI結尾後有事件');eot=true}
        else throw Error(`尚不支援MIDI meta ${kind}，未靜默忽略`);
      }else if(status>=128&&status<240){running=status;const kind=status>>4,ch=status&15,a=byte(),b=[12,13].includes(kind)?null:byte();if(a>127||b>127)throw Error('無效MIDI資料');if(ti===0)throw Error('Conductor含演奏／控制事件');channelSet.add(ch);
        if(kind===9&&b>0){if(active.has(a))throw Error('同軌同音重疊起音');active.set(a,{pitch:a,start:beat,velocity:b})}
        else if(kind===8||kind===9&&b===0){const e=active.get(a);if(!e||f(beat).cmp(e.start)<=0)throw Error('note-off不匹配');track.events.push({...e,end:beat});active.delete(a)}
        else if(kind===11){if(![7,11,64].includes(a))throw Error(`尚不支援CC${a}`);track.controls.push({beat,controller:a,value:b})}
        else if(kind===12){if(!eq(beat,0)||track.program!==null)throw Error('本版不接受中途或重複Program');track.program=a}
        else if(kind===14)track.controls.push({beat,controller:'pitchbend',value:a+128*b-8192});
        else throw Error(`尚不支援MIDI控制類型${kind}`);
      }else throw Error('不支援的MIDI訊息');
    }if(!eot||active.size)throw Error('MIDI缺少完整結尾或仍有未結束音符');if(channelSet.size>1)throw Error('同一演奏軌出現多個頻道');track.channel=channelSet.size?[...channelSet][0]:null;track.events.sort((a,b)=>f(a.start).cmp(b.start)||a.pitch-b.pitch);tracks.push(track);totals.push(String(new F(tick,ppq)));
  }if(p!==bytes.length||new Set(totals).size!==1)throw Error('MIDI尾端資料或各軌長度不一致');return {tempo,meter,total:totals[0],tracks};
}
const stable=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v);
function orderedEvents(t){return t.events.map(e=>({pitch:e.pitch,start:String(f(e.start)),end:String(f(e.end)),velocity:e.velocity}))}
export function compareMidi(song,actual){const expected=expectedMidi(song),errors=[];
  for(const key of ['tempo','meter','total'])if(stable(expected[key])!==stable(actual[key]))errors.push(`${key==='meter'?'拍號圖':key==='tempo'?'Tempo Map':'總拍長'}不一致`);
  if(actual.tracks.length!==7)errors.push('需要Conductor＋六演奏軌');
  for(let i=0;i<7;i++){const a=actual.tracks[i],e=expected.tracks[i];if(!a){errors.push(`缺少${e.role}`);continue}if(a.role!==e.role)errors.push(`${e.role}軌名／順序不一致`);if(a.channel!==e.channel)errors.push(`${e.role}頻道不一致`);if(a.program!==e.program)errors.push(`${e.role}Program不一致`);if(stable(orderedEvents(a))!==stable(orderedEvents(e)))errors.push(`${e.role}音高／起點／音尾／力度不一致`);if(stable(a.controls)!==stable(e.controls))errors.push(`${e.role}音量／控制事件不一致`)}return {ok:!errors.length,errors};
}
export function abcPitch(p){const names=['=C','^C','=D','^D','=E','=F','^F','=G','^G','=A','^A','=B'];const octave=Math.floor(p/12)-1;return names[p%12]+(octave<4?','.repeat(4-octave):"'".repeat(octave-4))}
export function writeABC(song){const lines=['X:1','T:'+song.title.replace(/[\r\n]/g,' '),'M:'+song.meter[0].numerator+'/'+song.meter[0].denominator,'L:1/4','Q:1/4='+song.tempo[0].bpm,'K:C','%%score (Conductor '+ROLES.join(' ')+')'];
  for(let idx=-1;idx<6;idx++){const role=idx<0?'Conductor':ROLES[idx],track=song.tracks[idx];lines.push(`V:${role} name="${role}"`+(song.drums?.role===role?' clef=perc':''));if(idx>=0&&song.drums?.role!==role)lines.push('%%MIDI program '+song.programs[idx]);let prevMeter='';
    for(const bar of song.bars){const sig=bar.numerator+'/'+bar.denominator,tokens=[];if(prevMeter&&prevMeter!==sig)tokens.push('[M:'+sig+']');prevMeter=sig;let cursor=f(bar.start);const all=[f(bar.start),f(bar.end)];
      for(const e of track?.events||[])for(const x of [e.start,e.end])if(f(x).cmp(bar.start)>0&&f(x).cmp(bar.end)<0)all.push(f(x));
      const changes=idx<0?song.tempo:canonicalControls(track);for(const c of changes)if(f(c.beat).cmp(bar.start)>=0&&f(c.beat).cmp(bar.end)<0)all.push(f(c.beat));
      const boundaries=[...new Set(all.map(String))].map(f).sort((a,b)=>a.cmp(b));
      for(let bi=0;bi<boundaries.length-1;bi++){cursor=boundaries[bi];const end=boundaries[bi+1];for(const c of changes)if(eq(c.beat,cursor))tokens.push(idx<0?`!t${c.bpm}!`:`!v${c.value}!`);const e=track?.events.find(e=>f(e.start).cmp(cursor)<=0&&f(e.end).cmp(cursor)>0);const pitch=e?(song.drums?.role===role?song.drums.mapping[e.pitch]:e.pitch):null;tokens.push((e?abcPitch(pitch):'z')+(eq(end.sub(cursor),1)?'':String(end.sub(cursor)))+(e&&f(e.end).cmp(end)>0?'-':''))}
      lines.push(tokens.join(' ')+' |');
    }
    const terminal=idx<0?song.tempo:canonicalControls(track);for(const c of terminal)if(eq(c.beat,song.total))lines.push(idx<0?`!t${c.bpm}!`:`!v${c.value}!`);
  }return lines.join('\n')+'\n';
}
export async function sha256(data){const bytes=typeof data==='string'?encoder.encode(data):data;const hash=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('')}
// Independent decoder for this exporter's explicitly expanded ABC subset.
// It reads the emitted text, including meter changes and controls, before export.
export function readABC(text,{pickup='',finalPartial=''}={}){
  let current=null,meterHeader=null,bpmHeader=null,lengthHeader=null;const voices=[];
  for(const raw of text.split('\n')){const line=raw.trim();if(!line)continue;
    if(line.startsWith('M:')){if(current)throw Error('拍號變化需明確行內表示');const m=/^M:(\d+)\/(\d+)$/.exec(line);if(!m)throw Error('ABC拍號無效');meterHeader={beat:'0',numerator:Number(m[1]),denominator:Number(m[2])};continue}
    if(line.startsWith('L:')){lengthHeader=line.slice(2);continue}if(line.startsWith('Q:')){const m=/^Q:1\/4=(\d+)$/.exec(line);if(!m)throw Error('ABC速度基準無效');bpmHeader=Number(m[1]);continue}
    if(line.startsWith('V:')){const m=/^V:(Conductor|Melody|Chord[1-5]) name="\1"( clef=perc)?$/.exec(line);if(!m||voices.some(v=>v.role===m[1]))throw Error('ABC軌名／重複軌無效');current={role:m[1],percussion:!!m[2],program:null,body:[]};voices.push(current);continue}
    if(line.startsWith('%%MIDI program ')){if(!current)throw Error('ABC Program缺少軌');current.program=Number(line.slice(15));continue}
    if(/^(X:|T:|K:C$|%%score )/.test(line))continue;
    if(!current)throw Error('ABC音符未指定軌');current.body.push(line);
  }
  if(lengthHeader!=='1/4'||!meterHeader||!bpmHeader||voices.length!==7||voices.map(v=>v.role).join(',')!==['Conductor',...ROLES].join(','))throw Error('ABC標頭／七軌結構不符');
  const decoded=[];let globalTempo=[],globalMeter=[],globalTotal='0';
  for(let vi=0;vi<voices.length;vi++){const v=voices[vi],body=v.body.join(' ');let pos=0,time=f(0),local=f(0),pending=null;const events=[],controls=[],tempo=[],meter=[{...meterHeader}],barEnds=[];
    while(pos<body.length){if(/\s/.test(body[pos])){pos++;continue}if(body[pos]==='|'){if(eq(local,0))throw Error('ABC空小節');barEnds.push(String(time));local=f(0);pos++;continue}
      const tail=body.slice(pos),m=/^\[M:(\d+)\/(\d+)\]/.exec(tail);if(m){if(!eq(local,0))throw Error('ABC在小節中間變拍');meter.push({beat:String(time),numerator:Number(m[1]),denominator:Number(m[2])});pos+=m[0].length;continue}
      const decoration=/^!(t|v)(\d+)!/.exec(tail);if(decoration){if(decoration[1]==='t'){if(vi)throw Error('ABC Tempo不在Conductor');tempo.push({beat:String(time),microseconds:Math.round(60000000/Number(decoration[2]))})}else controls.push({beat:String(time),controller:7,value:Number(decoration[2])});pos+=decoration[0].length;continue}
      const note=/^(z|[=^_]{1,2}[A-G][,']*)(\d+(?:\/\d+)?|\/\d+)?(-?)/.exec(tail);if(!note)throw Error('ABC含未支援或未展開語法：'+tail.slice(0,18));const duration=f(!note[2]?'1':note[2].startsWith('/')?'1'+note[2]:note[2]);if(duration.cmp(0)<=0)throw Error('ABC時值非正');const end=time.add(duration);
      if(note[1]==='z'){if(pending||note[3])throw Error('ABC休止符接延音')}
      else{if(!vi)throw Error('Conductor不應有音符');const n=/^([=^_]{1,2})([A-G])([,']*)$/.exec(note[1]);const octave=4+[...n[3]].reduce((a,c)=>a+(c==="'"?1:-1),0);const pitch=12*(octave+1)+noteBase[n[2].toLowerCase()]+[...n[1]].reduce((a,c)=>a+(c==='^'?1:c==='_'?-1:0),0);if(pending!==null){if(pending!==pitch||!eq(events.at(-1).end,time))throw Error('ABC延音不同音高');events.at(-1).end=String(end)}else events.push({pitch,start:String(time),end:String(end),velocity:100});pending=note[3]?pitch:null}
      time=end;local=local.add(duration);pos+=note[0].length;
    }
    if(pending!==null||!eq(local,0))throw Error('ABC尾端未完成');const expectedBars=buildBars(time,meter,pickup,finalPartial);if(JSON.stringify(expectedBars.map(b=>b.end))!==JSON.stringify(barEnds))throw Error(v.role+' ABC逐小節總和不符');
    if(!vi){globalTotal=String(time);globalTempo=tempo;globalMeter=meter;if(!tempo.length||tempo[0].beat!=='0'||tempo[0].microseconds!==Math.round(60000000/bpmHeader))throw Error('ABC初始Tempo不一致')}
    else if(String(time)!==globalTotal||JSON.stringify(meter)!==JSON.stringify(globalMeter))throw Error('ABC各軌總長／拍號不一致');
    decoded.push({role:v.role,channel:vi?(v.percussion?9:vi-1):null,program:v.program,events,controls});
  }return {tempo:globalTempo,meter:globalMeter,total:globalTotal,tracks:decoded};
}
export const DEMO='MML@t120o4v10l4ceg>c<gec2t138c2deg2c1,t120o4v7l4egceegcet138g2e1c1,t120o3v8l2cgfgt138c2g1c1,t120o2v5l1cr1t138c2r1c1,t120o5v5l4r1r1t138r2g4e4r2c1,t120o4v4r1r1t138r2r1g1;';
