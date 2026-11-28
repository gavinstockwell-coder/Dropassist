// Interactive starry-night background: twinkling stars in three depth layers that drift away from the cursor,
// a click launches a shooting star, and one streaks across on its own now and then.
(function () {
  'use strict';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cv = document.createElement('canvas');
  cv.id = 'stars';
  cv.setAttribute('aria-hidden', 'true');
  document.documentElement.prepend(cv);
  const ctx = cv.getContext('2d');
  let W = 0, H = 0, dpr = 1, stars = [], shots = [];
  let mx = 0.5, my = 0.5, tx = 0.5, ty = 0.5;
  let K = 1, starCol = '#f4f6ff', blueCol = '#b9cdff';
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    K = parseFloat(cs.getPropertyValue('--star')) || 0;
    if (document.documentElement.dataset.stars === 'off') K = 0;
    starCol = cs.getPropertyValue('--fg').trim() || '#f4f6ff';
    blueCol = document.documentElement.dataset.theme === 'night' || !document.documentElement.dataset.theme ? '#b9cdff' : starCol;
  }
  addEventListener('db-theme', readTheme);

  function build() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = innerWidth; H = Math.max(innerHeight, document.documentElement.clientHeight);
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round((W * H) / 2200);
    stars = Array.from({ length: n }, () => {
      const z = Math.random();
      return {
        x: Math.random() * W, y: Math.random() * H, z,
        r: 0.3 + z * 1.3, a: 0.35 + Math.random() * 0.65,
        tw: 0.5 + Math.random() * 2.5, ph: Math.random() * Math.PI * 2,
        blue: Math.random() < 0.25
      };
    });
  }

  function shoot(x, y) {
    const ang = Math.PI * (0.15 + Math.random() * 0.2);
    const sp = 9 + Math.random() * 6;
    shots.push({ x: x ?? Math.random() * W * 0.8, y: y ?? Math.random() * H * 0.4, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 1 });
  }

  let last = performance.now(), nextAuto = last + 4000 + Math.random() * 6000;
  function frame(t) {
    const dt = Math.min(50, t - last); last = t;
    mx += (tx - mx) * 0.05; my += (ty - my) * 0.05;
    ctx.clearRect(0, 0, W, H);
    if (!K) { if (!document.hidden) requestAnimationFrame(frame); return; }
    for (const s of stars) {
      const px = (mx - 0.5) * -28 * s.z, py = (my - 0.5) * -28 * s.z;
      let x = (s.x + px) % W, y = (s.y + py) % H;
      if (x < 0) x += W; if (y < 0) y += H;
      const a = reduce ? s.a : s.a * (0.6 + 0.4 * Math.sin(t / 1000 * s.tw + s.ph));
      const dx = x - mx * W, dy = y - my * H, near = Math.max(0, 1 - Math.hypot(dx, dy) / 120);
      ctx.globalAlpha = Math.min(1, a + near * 0.6) * K;
      ctx.fillStyle = s.blue ? blueCol : starCol;
      ctx.beginPath(); ctx.arc(x, y, s.r + near * 0.8, 0, Math.PI * 2); ctx.fill();
    }
    if (!reduce && t > nextAuto) { shoot(); nextAuto = t + 6000 + Math.random() * 9000; }
    for (const sh of shots) {
      sh.x += sh.vx * dt / 16; sh.y += sh.vy * dt / 16; sh.life -= dt / 900;
      const g = ctx.createLinearGradient(sh.x, sh.y, sh.x - sh.vx * 9, sh.y - sh.vy * 9);
      g.addColorStop(0, `rgba(255,255,255,${Math.max(0, sh.life)})`); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = 1; ctx.strokeStyle = g; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(sh.x - sh.vx * 9, sh.y - sh.vy * 9); ctx.stroke();
    }
    shots = shots.filter((s) => s.life > 0 && s.x < W + 200 && s.y < H + 200);
    ctx.globalAlpha = 1;
    if (!document.hidden) requestAnimationFrame(frame);
  }

  addEventListener('resize', build);
  addEventListener('mousemove', (e) => { tx = e.clientX / W; ty = e.clientY / H; });
  addEventListener('click', (e) => {
    if (e.target.closest('button, a, input, select, label, summary, textarea, pre')) return;
    shoot(e.clientX - 60, e.clientY - 30);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { last = performance.now(); requestAnimationFrame(frame); } });
  build();
  readTheme();
  requestAnimationFrame(frame);
})();
