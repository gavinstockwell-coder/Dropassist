// Offscreen document: the only MV3 context that can play audio without a user gesture.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'beep') return false;
  play(msg.kind);
  return false;
});

function play(kind) {
  const ctx = new AudioContext();
  const seq = kind === 'warn' ? [660, 0, 660, 0, 660] : [880, 1175, 1568, 0, 1568, 0, 1568];
  let t = ctx.currentTime + 0.02;
  for (const f of seq) {
    if (f) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.19);
    }
    t += 0.19;
  }
  setTimeout(() => ctx.close(), 2500);
}
