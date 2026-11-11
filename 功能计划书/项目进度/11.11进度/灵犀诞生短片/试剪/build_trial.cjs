// 试剪音轨的生成脚本。用法（需要 Mac 自带的 afconvert）：
//   afconvert -f WAVE -d LEI16@44100 -c 1 ../music.m4a /tmp/m44.wav && node build_trial.cjs /tmp/m44.wav hits.json trial.wav
// 试剪音轨：从配乐里剪出 29.80–46.60 秒，在四个关键拍上叠一记合成的低频重击（位置对到原曲在那一拍的起音）
const fs=require("fs");const b=fs.readFileSync(process.argv[2]);const o=b.indexOf("data")+8,sr=44100,n=(b.length-o)>>1;const x=new Float32Array(n);for(let i=0;i<n;i++)x[i]=b.readInt16LE(o+i*2)/32768;
const {H}=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));
const S0=29.80,S1=46.60,BP0=0.53128,B00=0.07;
// 用这一段里实测的敲击点拟合拍子网格
const pts=[];for(const [t] of H){if(t<27||t>48)continue;const bt=(t-B00)/BP0,k=Math.round(bt);if(Math.abs(bt-k)<0.12)pts.push([k,t])}
const mk=pts.reduce((s,p)=>s+p[0],0)/pts.length,mt=pts.reduce((s,p)=>s+p[1],0)/pts.length;let sxy=0,sxx=0;for(const [k,t] of pts){sxy+=(k-mk)*(t-mt);sxx+=(k-mk)**2}
const P=sxy/sxx,A0=mt-P*mk;let rm=0,mx=0;for(const [k,t] of pts){const r=t-(A0+P*k);rm+=r*r;mx=Math.max(mx,Math.abs(r))}
const beat=(k)=>A0+P*k;const near=(k)=>{let best=null;for(const [t] of H)if(Math.abs(t-beat(k))<0.03&&(!best||Math.abs(t-beat(k))<Math.abs(best-beat(k))))best=t;return best};
console.log("grid: beat(k) =",A0.toFixed(4),"+",P.toFixed(5),"* k   points",pts.length,"rms",(Math.sqrt(rm/pts.length)*1000).toFixed(1)+"ms","max",(mx*1000).toFixed(1)+"ms");
const KICKS=[[69,1],[73,0.85],[77,0.75],[81,1]].map(([k,g])=>[k,near(k)??beat(k),g]);
const i0=Math.round(S0*sr),N=Math.round((S1-S0)*sr),y=new Float32Array(N);
for(let i=0;i<N;i++){const t=i/sr;let g=0.8*Math.min(1,t/0.25);const tail=(S1-S0)-t;if(tail<1.3){const k=tail/1.3;g*=k*k*(3-2*k)}y[i]=x[i0+i]*g}
let seed=7;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296-0.5};
// 重击：低频扫落的鼓身 + 一下木质的敲击头；落下的瞬间把原曲压低再放回来；最关键的两拍，落拍前先抽掉一小口
for(const [k,t,g] of KICKS){const s=Math.round((t-S0)*sr);let ph=0,pn=0;
  if(g>=1){const pre=Math.round(0.17*sr);for(let i=0;i<pre;i++){const u=i/pre;y[s-pre+i]*=1-0.72*u*u}}
  for(let i=0;i<Math.round(0.8*sr)&&s+i<N;i++){const u=i/sr,f=46+130*Math.exp(-u*26);ph+=2*Math.PI*f/sr;
  const body=Math.sin(ph)*Math.exp(-u*6)*(1-Math.exp(-u*2500)),knock=Math.sin(2*Math.PI*1750*u)*Math.exp(-u*190)*0.38,nz=rnd(),click=(nz-pn)*Math.exp(-u*600)*0.45;pn=nz;
  y[s+i]=y[s+i]*(1-0.68*Math.exp(-u*9))+g*(0.86*body+knock+0.2*click)}}
const out=Buffer.alloc(44+N*2);out.write("RIFF",0);out.writeUInt32LE(36+N*2,4);out.write("WAVEfmt ",8);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(sr,24);out.writeUInt32LE(sr*2,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write("data",36);out.writeUInt32LE(N*2,40);
let clip=0;for(let i=0;i<N;i++){let v=Math.tanh(y[i]*1.15)/Math.tanh(1.15);if(Math.abs(y[i])>1)clip++;out.writeInt16LE(Math.round(Math.max(-1,Math.min(1,v))*32767),44+i*2)}
fs.writeFileSync(process.argv[4],out);
console.log("length",(N/sr).toFixed(2)+"s","samples over 1.0 before limiter",clip);
console.log("beats (local seconds):",Array.from({length:31},(_,j)=>56+j).map(k=>k+":"+(beat(k)-S0).toFixed(3)).join(" "));
console.log("kicks (local seconds):",KICKS.map(([k,t,g])=>"beat"+k+"="+(t-S0).toFixed(3)+" (src "+t.toFixed(3)+", grid "+beat(k).toFixed(3)+")").join("  "));
