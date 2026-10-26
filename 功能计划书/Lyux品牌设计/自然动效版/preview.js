(function () {
  'use strict';
  const concepts = window.LyuxConcepts || [];
  const stateNames = {idle:'待机',thinking:'思考',running:'运行'};
  const root = document.getElementById('concepts');
  const pause = document.getElementById('pause');
  const demo = document.getElementById('demo');
  const tone = document.getElementById('tone');
  const status = document.getElementById('playback-status');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let state = 'thinking';
  let isPaused = false;
  let demoActive = false;
  let demoTimer = null;
  let demoIndex = 0;
  const timeline = [{state:'idle',duration:3500},{state:'thinking',duration:6500},{state:'running',duration:5000}];
  const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function miniSvg(svg, size) {
    return svg.replace('role="img"','aria-hidden="true"').replace('<svg ','<svg style="--sample-size:'+size+'px" ');
  }
  root.innerHTML = concepts.map(c => `<article class="candidate" data-concept="${escape(c.id)}" aria-labelledby="title-${escape(c.id)}">
    <div class="candidate-header"><h2 id="title-${escape(c.id)}">${escape(c.name)}</h2><a href="exports/${escape(c.id)}-thinking.svg" data-download="${escape(c.id)}" download>下载动态标志</a></div>
    <div class="artboard"><div class="main-mark">${c.svg}</div><div class="wordmark">Lyux<small>灵犀</small></div></div>
    <p class="tagline">${escape(c.tagline)}</p><p class="motion-note">${escape(c.motion.thinking)}</p>
    <div class="usage-row"><div class="small-brand"><span class="small-mark">${miniSvg(c.svg,32)}</span>Lyux</div><div class="size-tests"><span class="size-test">${miniSvg(c.svg,24)}<span>24</span></span><span class="size-test">${miniSvg(c.svg,16)}<span>16</span></span></div></div>
  </article>`).join('');

  function setState(next) {
    state = stateNames[next] ? next : 'idle';
    document.querySelectorAll('[data-state-button]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.stateButton === state)));
    concepts.forEach(c => {
      const card = document.querySelector('[data-concept="'+c.id+'"]');
      card.querySelectorAll('.lx-logo').forEach(svg => svg.dataset.state = state);
      card.querySelector('.main-mark .lx-logo').setAttribute('aria-label','Lyux '+c.name+'，'+stateNames[state]+'状态');
      card.querySelector('.motion-note').textContent = c.motion[state];
      card.querySelector('[data-download]').href = 'exports/'+c.id+'-'+state+'.svg';
    });
    updateStatus();
  }
  function updateStatus() {
    status.textContent = (reduced.matches ? '系统已减少动态效果 · ' : isPaused ? '动画已暂停 · ' : demoActive ? '完整演示 · ' : '正在预览') + stateNames[state] + '状态';
    pause.textContent = reduced.matches ? '系统已减少动画' : isPaused ? '继续动画' : '暂停动画';
    pause.disabled = reduced.matches;
    demo.disabled = reduced.matches;
    pause.setAttribute('aria-pressed',String(isPaused || reduced.matches));
    demo.setAttribute('aria-pressed',String(demoActive));
    demo.textContent = demoActive ? '结束演示' : '完整演示';
  }
  function stopDemo() {
    clearTimeout(demoTimer); demoTimer = null; demoActive = false;
    updateStatus();
  }
  function scheduleDemo() {
    clearTimeout(demoTimer);
    if (!demoActive || isPaused || document.hidden || reduced.matches) return;
    demoTimer = setTimeout(() => {
      demoIndex = (demoIndex + 1) % timeline.length;
      setState(timeline[demoIndex].state);
      scheduleDemo();
    }, timeline[demoIndex].duration);
  }
  document.querySelectorAll('[data-state-button]').forEach(button => button.addEventListener('click', () => {stopDemo();setState(button.dataset.stateButton);}));
  document.querySelectorAll('[data-download]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault();
    const concept = concepts.find(c => c.id === link.dataset.download);
    const svg = concept.svg.replace('<svg ','<svg width="120" height="120" ').replace('data-state="idle"','data-state="'+state+'"');
    const url = URL.createObjectURL(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}));
    const download = document.createElement('a');
    download.href = url; download.download = 'Lyux-'+concept.id+'-'+state+'.svg';
    document.body.appendChild(download); download.click(); download.remove();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  }));
  pause.addEventListener('click', () => {
    isPaused = !isPaused;
    document.body.classList.toggle('is-paused',isPaused);
    updateStatus(); scheduleDemo();
  });
  demo.addEventListener('click', () => {
    if (demoActive) return stopDemo();
    isPaused = false; document.body.classList.remove('is-paused');
    demoActive = true; demoIndex = 0; setState(timeline[0].state); scheduleDemo();
  });
  tone.addEventListener('click', () => {
    const dark = document.body.classList.toggle('dark-artboards');
    tone.setAttribute('aria-pressed',String(dark));
    tone.textContent = dark ? '浅色背景' : '深色背景';
  });
  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('is-hidden',document.hidden);
    scheduleDemo();
  });
  reduced.addEventListener('change', () => {if (reduced.matches) stopDemo();updateStatus();});
  const observer = new IntersectionObserver(entries => entries.forEach(entry => entry.target.classList.toggle('is-offscreen',!entry.isIntersecting)),{rootMargin:'40px'});
  document.querySelectorAll('.candidate').forEach(card => observer.observe(card));
  document.body.classList.toggle('is-hidden',document.hidden);
  setState(state);
}());
