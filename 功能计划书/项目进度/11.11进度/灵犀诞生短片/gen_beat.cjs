// 配乐分析：从 music.m4a 算出起音点和响度包络，写成 beat.js（画面靠它跟着音乐起伏）。换了配乐后重新运行：
//   afconvert -f WAVE -d LEI16@22050 -c 1 music.m4a /tmp/m.wav && node gen_beat.cjs /tmp/m.wav beat.js
const fs=require('fs');const b=fs.readFileSync(process.argv[2]||'m.wav');const o0=b.indexOf('data')+8;const sr=22050;const n=(b.length-o0)>>1;const x=new Float32Array(n);for(let i=0;i<n;i++)x[i]=b.readInt16LE(o0+i*2)/32768;
const N=1024,hop=256,fps=sr/hop,nf=Math.floor((n-N)/hop),nb=N/2+1;const win=new Float32Array(N);for(let i=0;i<N;i++)win[i]=0.5-0.5*Math.cos(2*Math.PI*i/N);
function fft(re,im){const n=re.length;for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]]}}
 for(let len=2;len<=n;len<<=1){const ang=-2*Math.PI/len,wr=Math.cos(ang),wi=Math.sin(ang);for(let i=0;i<n;i+=len){let cr=1,ci=0;for(let k=0;k<len/2;k++){const a=i+k,c=a+len/2,tr=re[c]*cr-im[c]*ci,ti=re[c]*ci+im[c]*cr;re[c]=re[a]-tr;im[c]=im[a]-ti;re[a]+=tr;im[a]+=ti;const t=cr*wr-ci*wi;ci=cr*wi+ci*wr;cr=t}}}}
const flux=new Float32Array(nf),low=new Float32Array(nf),lowe=new Float32Array(nf),hie=new Float32Array(nf);let prev=new Float32Array(nb);const lb=Math.floor(160/(sr/N));
for(let f=0;f<nf;f++){const re=new Float32Array(N),im=new Float32Array(N);for(let i=0;i<N;i++)re[i]=x[f*hop+i]*win[i];fft(re,im);const L=new Float32Array(nb);let fl=0,lo=0,le=0,he=0;
 for(let k=0;k<nb;k++){const m=Math.hypot(re[k],im[k]);L[k]=Math.log1p(50*m);const d=L[k]-prev[k];if(d>0){fl+=d;if(k<=lb)lo+=d}if(k<=lb)le+=m;if(k>180)he+=m}flux[f]=fl;low[f]=lo;lowe[f]=le;hie[f]=he;prev=L}
function norm(v){const k=Math.round(fps*0.4),out=new Float32Array(v.length);let s=0;for(let i=0;i<v.length;i++){s+=v[i];if(i>=k)s-=v[i-k];out[i]=Math.max(0,v[i]-s/Math.min(i+1,k))}let m=0,q=0;for(const a of out){m+=a}m/=out.length;for(const a of out)q+=(a-m)**2;const sd=Math.sqrt(q/out.length);return out.map(a=>a/sd)}
const o=norm(flux),ol=norm(low);
function ac(l){let s=0;const L=Math.round(l);for(let i=0;i+L<nf;i++)s+=o[i]*o[i+L];return s}
let cands=[];for(let bpm=50;bpm<200;bpm+=0.25){const lag=60/bpm*fps;cands.push([ac(lag)+0.5*ac(2*lag)+0.25*ac(4*lag),bpm])}cands.sort((a,b)=>b[0]-a[0]);console.log('tempo',cands.slice(0,8).map(c=>c[1]+':'+Math.round(c[0])).join(' '));
const arg=null;const bpm=arg?parseFloat(arg):cands[0][1],per=60/bpm*fps;
const cum=Float32Array.from(o),back=new Int32Array(nf).fill(-1),lo=Math.round(per*0.5),hi=Math.round(per*2);
for(let i=hi;i<nf;i++){let bs=-1e9,bj=-1;for(let j=i-hi;j<i-lo;j++){const pen=-100*Math.log((i-j)/per)**2,sc=cum[j]+pen;if(sc>bs){bs=sc;bj=j}}cum[i]=o[i]+bs;back[i]=bj}
let bi=nf-1,bv=-1e9;for(let i=nf-Math.round(per*2);i<nf;i++)if(cum[i]>bv){bv=cum[i];bi=i}const beats=[];for(let i=bi;i>0;i=back[i])beats.push(i);beats.reverse();
const bt=beats.map(i=>i/fps+N/2/sr);const ibi=bt.slice(1).map((v,i)=>v-bt[i]).sort((a,b)=>a-b);console.log('bpm',bpm,'beats',bt.length,'first',bt.slice(0,6).map(v=>v.toFixed(2)).join(' '),'median ibi',ibi[ibi.length>>1].toFixed(4));
const pk=(v,i)=>{let m=0;for(let k=Math.max(0,i-2);k<=i+2&&k<nf;k++)m=Math.max(m,v[k]);return m};const bs=beats.map(i=>pk(ol,i)),fsx=beats.map(i=>pk(o,i));
for(let ph=0;ph<4;ph++){let a=0,c=0,d=0;for(let i=ph;i<bs.length;i+=4){a+=bs[i];d+=fsx[i];c++}console.log('phase',ph,'low',(a/c).toFixed(2),'flux',(d/c).toFixed(2))}
const p99=v=>{const s=Float32Array.from(v).sort();return s[Math.floor(s.length*0.99)]};const l9=p99(lowe),h9=p99(hie);
const E=[];const w=Math.round(sr*0.25);let acc=0;const pre=new Float64Array(n+1);for(let i=0;i<n;i++)pre[i+1]=pre[i]+x[i]*x[i];for(let t=0;t*sr/20<n;t++){const c=Math.round(t*sr/20),a=Math.max(0,c-(w>>1)),e=Math.min(n,c+(w>>1));E.push(Math.sqrt((pre[e]-pre[a])/(e-a)))}const em=Math.max(...E);
for(let a=0;a<130;a+=5){const m=(v,f0,f1)=>{let s=0;for(let i=f0;i<f1&&i<v.length;i++)s+=v[i];return s/(f1-f0)};console.log(String(a).padStart(3),'rms',(m(E,a*20,(a+5)*20)/em).toFixed(2),'onset',m(o,Math.round(a*fps),Math.round((a+5)*fps)).toFixed(2),'low',(m(lowe,Math.round(a*fps),Math.round((a+5)*fps))/l9).toFixed(2),'hi',(m(hie,Math.round(a*fps),Math.round((a+5)*fps))/h9).toFixed(2))}
// strongest onsets
const pkx=[];for(let i=2;i<nf-2;i++)if(o[i]>o[i-1]&&o[i]>=o[i+1]&&o[i]>5)pkx.push([o[i],i/fps+N/2/sr]);pkx.sort((a,b)=>b[0]-a[0]);console.log('top onsets',pkx.slice(0,24).map(p=>p[1].toFixed(2)+'('+p[0].toFixed(0)+')').join(' '));
fs.writeFileSync('beat.json',JSON.stringify({bpm,beats:bt.map(v=>+v.toFixed(3)),bs:bs.map(v=>+v.toFixed(2)),fs:fsx.map(v=>+v.toFixed(2)),e:E.map(v=>+(v/em).toFixed(3)),lowe:Array.from(lowe).filter((_,i)=>i%4==0).map(v=>+Math.min(1.5,v/l9).toFixed(2))}));
// linear grid fit
{const k=bt.map((_,i)=>i);const nn=bt.length,mk=(nn-1)/2,mt=bt.reduce((a,b)=>a+b)/nn;let sxy=0,sxx=0;for(let i=0;i<nn;i++){sxy+=(i-mk)*(bt[i]-mt);sxx+=(i-mk)**2}const P=sxy/sxx,t0=mt-P*mk;let mx=0,rm=0;for(let i=0;i<nn;i++){const r=bt[i]-(t0+P*i);mx=Math.max(mx,Math.abs(r));rm+=r*r}console.log('grid P',P.toFixed(5),'t0',t0.toFixed(3),'bpm',(60/P).toFixed(3),'maxres',mx.toFixed(3),'rms',Math.sqrt(rm/nn).toFixed(3));
 const sec=(v,a)=>{let s=0,c=0;for(let i=Math.round(a*fps);i<Math.round((a+0.5)*fps)&&i<v.length;i++){s+=v[i];c++}return s/c};
 for(const [a,b] of [[13,23],[72,80],[90,98],[122,130]]){let s='';for(let t=a;t<b;t+=0.5)s+=t+':'+(sec(hie,t)/h9).toFixed(2)+'/'+(sec(lowe,t)/l9).toFixed(2)+' ';console.log(s)}
 // onset strength at grid beats by bar phase using fitted grid
 for(let ph=0;ph<4;ph++){let a=0,d=0,c=0;for(let i=ph;i<nn;i+=4){const f=Math.round((t0+P*i-N/2/sr)*fps);a+=pk(ol,f);d+=pk(o,f);c++}console.log('gridphase',ph,a/c,d/c)}
 // per-beat low strengths 30..50
 let s='';for(let i=0;i<nn;i++){const t=t0+P*i;if(t>28&&t<46)s+=t.toFixed(2)+':'+pk(ol,Math.round((t-N/2/sr)*fps)).toFixed(1)+'/'+pk(o,Math.round((t-N/2/sr)*fps)).toFixed(1)+' '}console.log(s)}
{ // 导出：起音点（时间, 强度）与 20Hz 的响度 / 低频 / 高频包络
 const ons=[];for(let i=3;i<nf-3;i++){let mx=true;for(let k=-3;k<=3;k++)if(o[i+k]>o[i])mx=false;if(mx&&o[i]>2.2){const t=i/fps+N/2/sr-0.02;if(!ons.length||t-ons[ons.length-1][0]>0.1)ons.push([+t.toFixed(2),+Math.min(1,o[i]/8).toFixed(2)])}}
 const at20=(v,nrm)=>{const out=[];for(let t=0;t<130*20;t++){const c=Math.round((t/20-N/2/sr)*fps);let s=0,cn=0;for(let k=c-6;k<=c+6;k++)if(k>=0&&k<nf){s+=v[k];cn++}out.push(+Math.min(1,s/(cn||1)/nrm).toFixed(2))}return out};
 const out={ons,e:E.slice(0,2600).map(v=>+(v/em).toFixed(2)),lo:at20(lowe,l9),hi:at20(hie,h9*0.6)};
 console.log('onsets',ons.length,'strong(>=0.7)',ons.filter(a=>a[1]>=0.7).length, ons.filter(a=>a[1]>=0.7).map(a=>a[0]).join(' '));
 fs.writeFileSync(process.argv[3]||'beat.js','// 配乐分析结果（由 music.m4a 离线算出）：ons 起音点 [秒, 强度 0–1]；e 响度、lo 低频、hi 高频，每秒 20 个值，0–1\nconst MUSIC = '+JSON.stringify(out)+';\n');}
