(function () {
  window.LyuxConcepts = window.LyuxConcepts || [];
  window.LyuxConcepts.push({
    id:'spirit',name:'小灵',tagline:'有耳朵，也有小心思',
    description:'把 y 的分叉化成两只软耳朵。圆润、略不对称的轮廓，适合作为聊天里的小伙伴。',
    motion:{idle:'轻轻呼吸，偶尔眨一下眼。',thinking:'耳朵稍稍侧过去，眼睛跟着看。',running:'轻轻点头，耳朵一前一后回应。'},
    svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" class="lx-logo ly-spirit" data-state="idle" role="img" aria-label="Lyux 小灵标志">
      <style>
      .ly-spirit .spirit-body{transform-origin:60px 83px}
      .ly-spirit .spirit-ear-left{transform-origin:40px 47px}
      .ly-spirit .spirit-ear-right{transform-origin:81px 47px}
      .ly-spirit .spirit-eye-left{transform-origin:46px 64px}
      .ly-spirit .spirit-eye-right{transform-origin:74px 63px}
      .ly-spirit .spirit-gaze{transform-origin:60px 64px}
      .ly-spirit[data-state="idle"] .spirit-body{animation:spirit-breathe 5.7s ease-in-out infinite}
      .ly-spirit[data-state="idle"] .spirit-eye{animation:spirit-blink 7.3s ease-in-out infinite}
      .ly-spirit[data-state="thinking"] .spirit-body{animation:spirit-listen 5.6s ease-in-out infinite}
      .ly-spirit[data-state="thinking"] .spirit-ear-left{animation:spirit-ear-left 5.6s ease-in-out infinite}
      .ly-spirit[data-state="thinking"] .spirit-ear-right{animation:spirit-ear-right 5.6s ease-in-out infinite}
      .ly-spirit[data-state="thinking"] .spirit-gaze{animation:spirit-gaze 5.6s ease-in-out infinite}
      .ly-spirit[data-state="thinking"] .spirit-eye{animation:spirit-blink 6.8s ease-in-out infinite}
      .ly-spirit[data-state="running"] .spirit-body{animation:spirit-nod 2.8s ease-in-out infinite}
      .ly-spirit[data-state="running"] .spirit-ear-left{animation:spirit-ear-left 2.8s ease-in-out infinite}
      .ly-spirit[data-state="running"] .spirit-ear-right{animation:spirit-ear-right 2.8s ease-in-out infinite}
      .ly-spirit[data-state="running"] .spirit-eye{animation:spirit-blink 6.4s ease-in-out infinite}
      @keyframes spirit-breathe{0%,100%{transform:scale(1) translateY(0)}50%{transform:scale(1.012,1.018) translateY(-.7px)}}
      @keyframes spirit-blink{0%,40%,45%,100%{transform:scaleY(1)}42%,43%{transform:scaleY(.12)}}
      @keyframes spirit-listen{0%,15%,88%,100%{transform:rotate(0)}35%,63%{transform:rotate(-3deg) translateY(-.5px)}}
      @keyframes spirit-ear-left{0%,15%,85%,100%{transform:rotate(0)}34%,50%{transform:rotate(-7deg)}67%{transform:rotate(1deg)}}
      @keyframes spirit-ear-right{0%,26%,96%,100%{transform:rotate(0)}47%,64%{transform:rotate(6deg)}80%{transform:rotate(-1deg)}}
      @keyframes spirit-gaze{0%,15%,88%,100%{transform:translate(0,0)}35%,62%{transform:translate(1.5px,-1.3px)}}
      @keyframes spirit-nod{0%,12%,82%,100%{transform:translateY(0) rotate(0)}35%{transform:translateY(1.4px) rotate(2deg)}59%{transform:translateY(-.7px) rotate(-1deg)}}
      @media(prefers-reduced-motion:reduce){.ly-spirit *{animation:none!important;transform:none!important}}
      </style>
      <g class="spirit-body">
        <path class="spirit-ear-left" fill="var(--mark-accent,#A5CCBE)" d="M32 50C25 41 19 25 24 20C29 15 43 26 51 40L48 51Z"/>
        <path class="spirit-ear-right" fill="var(--mark-primary,#4F969A)" d="M72 41C79 29 90 17 96 22C102 27 96 43 88 53Z"/>
        <path fill="var(--mark-primary,#4F969A)" d="M27 51C32 38 45 33 60 34C77 32 91 39 96 52C103 69 96 85 82 94C68 104 47 101 33 89C20 78 20 64 27 51Z"/>
        <g class="spirit-gaze" fill="var(--mark-ink,#254A50)"><ellipse class="spirit-eye spirit-eye-left" cx="46" cy="64" rx="3.6" ry="5.2"/><ellipse class="spirit-eye spirit-eye-right" cx="74" cy="63" rx="3.6" ry="5.2"/></g>
        <path d="M56 79Q61 82 66 78" fill="none" stroke="var(--mark-ink,#254A50)" stroke-width="2.2" stroke-linecap="round"/>
      </g>
    </svg>`
  });
}());
