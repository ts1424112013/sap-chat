(function () {
  'use strict';
  const names={idle:'静止',thinking:'思考中',running:'运行中'};
  const notes={idle:'叶翼回到原位，保留原稿轮廓。',thinking:'叶翼交替侧倾，主弧缓缓起伏。',running:'两片叶翼明显展开，主弧跟着起伏回应。'};
  const reduce=matchMedia('(prefers-reduced-motion: reduce)');
  const pauseButton=document.getElementById('pause');
  const demoButton=document.getElementById('demo');
  let state='running',paused=false,token=0,demoTimer=null,demoActive=false;
  document.querySelectorAll('.mark-slot').forEach(slot=>{
    slot.innerHTML=window.LingXiWing.svg(state);
    if(/^\d+$/.test(slot.dataset.size))slot.style.setProperty('--size',slot.dataset.size+'px');
  });
  const marks=()=>[...document.querySelectorAll('.wing-mark')];
  const parts=()=>[...document.querySelectorAll('.wing-stem,.wing-upper,.wing-lower')];
  const ourAnimations=()=>document.getAnimations().filter(a=>a.effect?.target?.closest('.wing-mark'));
  function renderStatus(){
    document.getElementById('status').textContent=(reduce.matches?'已减少动态效果 · ':paused?'已暂停 · ':'')+names[state]+' · '+notes[state];
    document.querySelector('.small-state').textContent=names[state];
    document.querySelectorAll('[data-state]').forEach(button=>{
      if(button.tagName==='BUTTON')button.setAttribute('aria-pressed',String(button.dataset.state===state));
    });
    pauseButton.textContent=reduce.matches?'系统已减少动画':paused?'继续动画':'暂停动画';
    pauseButton.disabled=reduce.matches;demoButton.disabled=reduce.matches;
    pauseButton.setAttribute('aria-pressed',String(paused||reduce.matches));
    demoButton.textContent=demoActive?'结束这次演示':'模拟一次运行';
    demoButton.setAttribute('aria-pressed',String(demoActive));
    document.getElementById('download').href='exports/LingXi-叶翼彩色-'+state+'.svg';
  }
  async function setState(next){
    const myToken=++token;
    state=Object.hasOwn(names,next)?next:'idle';
    renderStatus();
    const current=parts().map(el=>({el,transform:getComputedStyle(el).transform}));
    ourAnimations().forEach(animation=>animation.cancel());
    marks().forEach(svg=>svg.dataset.state='idle');
    if(!paused&&!reduce.matches){
      const settling=current.filter(x=>x.transform!=='none').map(({el,transform})=>el.animate([{transform},{transform:'none'}],{duration:380,easing:'cubic-bezier(.2,.7,.2,1)',fill:'both'}));
      await Promise.allSettled(settling.map(animation=>animation.finished));
      settling.forEach(animation=>animation.cancel());
    }
    if(myToken!==token)return;
    marks().forEach(svg=>svg.dataset.state=state);
  }
  function stopDemo(){clearTimeout(demoTimer);demoTimer=null;demoActive=false;renderStatus();}
  document.querySelectorAll('button[data-state]').forEach(button=>button.addEventListener('click',()=>{stopDemo();setState(button.dataset.state);}));
  pauseButton.addEventListener('click',()=>{
    paused=!paused;document.body.classList.toggle('is-paused',paused);
    ourAnimations().forEach(animation=>paused?animation.pause():animation.play());
    if(paused&&demoActive)stopDemo();
    renderStatus();
  });
  demoButton.addEventListener('click',()=>{
    if(demoActive){stopDemo();setState('idle');return;}
    paused=false;document.body.classList.remove('is-paused');
    demoActive=true;setState('running');
    demoTimer=setTimeout(()=>{demoActive=false;setState('idle');},8000);renderStatus();
  });
  document.getElementById('tone').addEventListener('click',event=>{
    const dark=document.body.classList.toggle('dark-preview');
    event.currentTarget.textContent=dark?'浅色背景':'深色背景';
    event.currentTarget.setAttribute('aria-pressed',String(dark));
  });
  document.getElementById('download').addEventListener('click',event=>{
    event.preventDefault();
    const svg=window.LingXiWing.svg(state);
    const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download='LingXi-叶翼彩色-'+state+'.svg';document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  document.addEventListener('visibilitychange',()=>{
    document.body.classList.toggle('is-hidden',document.hidden);
    ourAnimations().forEach(animation=>(document.hidden||paused)?animation.pause():animation.play());
  });
  reduce.addEventListener('change',()=>{
    if(reduce.matches){++token;stopDemo();ourAnimations().forEach(animation=>animation.cancel());marks().forEach(svg=>svg.dataset.state=state);}
    renderStatus();
  });
  document.body.classList.toggle('is-hidden',document.hidden);renderStatus();
}());
