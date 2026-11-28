// On-page UI for content scripts: a status banner (shadow DOM so site CSS can't break it), highlight, beep.
(function (root) {
  'use strict';
  const DA = (root.DA = root.DA || {});

  let host = null, els = null, tickTimer = null;

  const LOOKS = {
    night: { bg: 'radial-gradient(120% 90% at 50% -20%, rgba(60,80,130,.4), transparent 60%), #05070b', fg: '#e9ecf1', dim: '#7d8697', line: '#343d50', acc: '#c4372f', glow: 'rgba(120,150,230,.5)', body: '"DB Grotesk"', head: '"DB Grotesk"', num: 1 },
    terminal: { bg: '#1e1e1e', fg: '#d3d7cf', dim: '#8f948c', line: '#4a4a4a', acc: '#8ae234', glow: 'transparent', body: '"DB Ubuntu"', head: '"DB Ubuntu"', num: 1.05 },
    archive: { bg: 'radial-gradient(120% 90% at 50% -20%, rgba(142,27,27,.35), transparent 60%), #050303', fg: '#ece5d3', dim: '#8b8174', line: '#4a332b', acc: '#b3261e', glow: 'rgba(142,27,27,.55)', body: '"DB Plex"', head: '"DB SpaceMono"', num: 1 },
    mono: { bg: '#000', fg: '#fff', dim: '#8a8a8a', line: '#444', acc: '#fff', glow: 'rgba(255,255,255,.3)', body: '"DB SpaceMono"', head: '"DB SpaceMono"', num: .95 },
    paper: { bg: '#fff', fg: '#141414', dim: '#6b665c', line: '#c9c3b6', acc: '#c4372f', glow: 'transparent', body: '"DB Grotesk"', head: '"DB Grotesk"', num: 1 }
  };
  const FONTS = { ubuntu: '"DB Ubuntu"', grotesk: '"DB Grotesk"', spacemono: '"DB SpaceMono"', plex: '"DB Plex"', sharetech: '"DB ShareTech"', vt323: '"DB VT323"' };
  let look = LOOKS.night;
  function css(L) {
    return `
    :host { all: initial; }
    .wrap { position: fixed; top: 12px; right: 12px; z-index: 2147483647; width: 350px;
      font: 13px/1.45 ${L.body}, Consolas, monospace; background: ${L.bg}; color: ${L.fg};
      border: 1px solid ${L.line}; box-shadow: 0 10px 40px rgba(0,0,0,.6); padding: 12px 14px; }
    .wrap.ok { border-color: ${L.acc}; box-shadow: 0 0 22px ${L.glow}, 0 10px 40px rgba(0,0,0,.6); }
    .wrap.warn { border-style: dashed; border-color: ${L.acc}; }
    .wrap.err { border: 2px solid #e5484d; }
    .top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .brand { font: 700 15px ${L.head}, Consolas, monospace; letter-spacing: .08em; text-transform: uppercase; }
    .brand::after { content: '_'; color: ${L.acc}; animation: b 1.1s steps(1) infinite; }
    @keyframes b { 50% { opacity: 0; } }
    .tag { font-size: 10px; letter-spacing: .14em; color: ${L.acc}; border: 1px solid ${L.acc}; padding: 1px 6px; text-transform: uppercase; }
    .tag:empty { display: none; }
    .main { margin-top: 8px; font: 700 calc(15px * ${L.num})/1.25 ${L.head}, Consolas, monospace; text-transform: uppercase; letter-spacing: .03em; }
    .sub { margin-top: 5px; color: ${L.dim}; white-space: pre-line; font-size: 11.5px; }
    .cd { font: 700 calc(28px * ${L.num})/1.1 ${L.head}, Consolas, monospace; margin-top: 4px; text-shadow: 0 0 14px ${L.glow}; font-variant-numeric: tabular-nums; }
    .btns { margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap; }
    button { all: unset; cursor: pointer; border: 1px solid ${L.line}; color: ${L.fg}; padding: 4px 10px; font: 700 11px ${L.head}, Consolas, monospace; letter-spacing: .08em; text-transform: uppercase; }
    button:hover { border-color: ${L.acc}; }
    .x { border: none; padding: 0 4px; font-size: 15px; color: ${L.dim}; letter-spacing: 0; }
    .hidden { display: none; }
  `;
  }
  let styleEl = null;
  function loadFonts() {
    if (document.getElementById('dropbuddy-fonts')) return;
    const u = (f) => chrome.runtime.getURL('ui/fonts/' + f);
    const st = document.createElement('style');
    st.id = 'dropbuddy-fonts';
    st.textContent = [['DB Grotesk', 'space-grotesk-latin-700-normal.woff2', 700], ['DB Grotesk', 'space-grotesk-latin-400-normal.woff2', 400],
      ['DB SpaceMono', 'space-mono-latin-700-normal.woff2', 700], ['DB SpaceMono', 'space-mono-latin-400-normal.woff2', 400],
      ['DB Plex', 'ibm-plex-mono-latin-400-normal.woff2', 400], ['DB Plex', 'ibm-plex-mono-latin-700-normal.woff2', 700],
      ['DB ShareTech', 'share-tech-mono-latin-400-normal.woff2', '400 700'], ['DB Ubuntu', 'ubuntu-mono-latin-400-normal.woff2', 400], ['DB Ubuntu', 'ubuntu-mono-latin-700-normal.woff2', 700], ['DB VT323', 'vt323-latin-400-normal.woff2', '400 700']]
      .map(([n, f, w]) => `@font-face{font-family:"${n}";src:url("${u(f)}") format("woff2");font-weight:${w};font-display:swap}`).join('');
    (document.head || document.documentElement).appendChild(st);
  }
  function setTheme(theme, font) {
    look = Object.assign({}, LOOKS[theme] || LOOKS.night);
    if (font && FONTS[font]) { look.body = look.head = FONTS[font]; look.num = font === 'vt323' ? 1.35 : 1; }
    try { loadFonts(); } catch (_) { /* fonts are optional */ }
    if (styleEl) styleEl.textContent = css(look);
  }

  function ensure() {
    if (host && host.isConnected) return;
    host = document.createElement('dropbuddy-banner');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${css(look)}</style>
      <div class="wrap">
        <div class="top"><span class="brand">dropbuddy</span><span><span class="tag mode"></span> <button class="x" title="Hide">×</button></span></div>
        <div class="main"></div>
        <div class="cd hidden"></div>
        <div class="sub"></div>
        <div class="btns"></div>
      </div>`;
    styleEl = shadow.querySelector('style');
    els = {
      wrap: shadow.querySelector('.wrap'), main: shadow.querySelector('.main'), sub: shadow.querySelector('.sub'),
      cd: shadow.querySelector('.cd'), btns: shadow.querySelector('.btns'), mode: shadow.querySelector('.mode')
    };
    shadow.querySelector('.x').addEventListener('click', () => { host.style.display = 'none'; });
    (document.body || document.documentElement).appendChild(host);
  }

  const banner = {
    show(main, opts) {
      opts = opts || {};
      ensure();
      host.style.display = '';
      els.main.textContent = main || '';
      els.sub.textContent = opts.sub || '';
      els.wrap.className = 'wrap' + (opts.tone ? ' ' + opts.tone : '');
      els.mode.textContent = opts.dry ? 'DRY RUN' : (opts.mode || '');
      els.mode.className = 'tag mode' + (opts.dry ? ' dry' : '');
      if (!opts.keepCountdown) banner.countdown(null);
      els.btns.innerHTML = '';
      for (const b of opts.buttons || []) {
        const btn = document.createElement('button');
        btn.textContent = b.label;
        btn.addEventListener('click', b.onClick);
        els.btns.appendChild(btn);
      }
    },
    sub(text) { ensure(); els.sub.textContent = text || ''; },
    // getRemaining(): ms until target (already server-time adjusted by caller). Pass null to stop.
    countdown(getRemaining) {
      clearInterval(tickTimer);
      if (!els) return;
      if (!getRemaining) { els.cd.classList.add('hidden'); return; }
      els.cd.classList.remove('hidden');
      const tick = () => { els.cd.textContent = DA.time ? DA.time.formatCountdown(getRemaining()) : fallbackCd(getRemaining()); };
      tick();
      tickTimer = setInterval(tick, 100);
    },
    hide() { clearInterval(tickTimer); if (host) host.style.display = 'none'; }
  };

  function fallbackCd(ms) {
    if (!isFinite(ms)) return '–';
    const s = Math.max(0, ms) / 1000;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60).toFixed(1);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.padStart(4, '0')}`;
  }

  let styleTag = null;
  function highlight(el) {
    if (!el) return;
    if (!styleTag) {
      styleTag = document.createElement('style');
      styleTag.textContent = `@keyframes dropbuddy-pulse { 0%,100% { box-shadow: 0 0 0 3px #b08d57, 0 0 0 7px rgba(179,38,30,.55); } 50% { box-shadow: 0 0 0 3px #b08d57, 0 0 0 16px rgba(179,38,30,.12); } }
        [data-dropbuddy-hl] { animation: dropbuddy-pulse 1s ease-in-out infinite !important; outline: none !important; position: relative; z-index: 2; }`;
      document.documentElement.appendChild(styleTag);
    }
    el.setAttribute('data-dropbuddy-hl', '1');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // Page-side beep. Used only when the extension's offscreen audio isn't available.
  function beep(kind) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const seq = kind === 'warn' ? [660, 0, 660] : [880, 1175, 1568, 0, 1568];
      let t = ctx.currentTime + 0.02;
      for (const f of seq) {
        if (f) {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'square'; o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
          o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.18);
        }
        t += 0.18;
      }
      setTimeout(() => ctx.close(), 2000);
    } catch (_) { /* autoplay blocked; the desktop notification still fires */ }
  }

  DA.ui = { banner, highlight, beep, setTheme };
})(typeof self !== 'undefined' ? self : globalThis);
