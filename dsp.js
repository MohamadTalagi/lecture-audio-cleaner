// Builds the cleanup chain between a source node and ctx.destination.
// spectral hiss reduction -> highpass -> mains-hum notch comb (50/60 Hz auto) -> lowpass 7.5 kHz
// -> voice EQ -> compressor -> voice boost -> limiter

export async function buildChain(ctx, source, workletUrl, params = {}) {
  await ctx.audioWorklet.addModule(workletUrl);
  const sr = ctx.sampleRate;
  const bq = (type, f, Q, g) => {
    const n = ctx.createBiquadFilter();
    n.type = type; n.frequency.value = f;
    if (Q !== undefined) n.Q.value = Q;
    if (g !== undefined) n.gain.value = g;
    return n;
  };

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 32768; analyser.smoothingTimeConstant = 0.95;
  source.connect(analyser);

  // Hiss reduction runs first, on the raw signal, so it sees true digital silence when paused
  const den = new AudioWorkletNode(ctx, 'lecture-denoiser', { outputChannelCount: [2] });
  const nodes = [den, bq('highpass', 75, 0.7)];
  const notches = [];
  for (let k = 1; k * 50 <= 6000; k++) { const n = bq('notch', 50 * k, 30); notches.push(n); nodes.push(n); }
  let mains = 50;
  const setMains = (f0) => {
    mains = f0;
    notches.forEach((n, i) => {
      const k = i + 1, fk = k * f0;
      const bw = k <= 4 ? fk / 30 : Math.min(Math.max(fk / 50, 3), 15);
      n.frequency.value = Math.min(fk, sr / 2 - 100);
      n.Q.value = fk / bw;
    });
  };
  setMains(50);
  // 8th-order Butterworth low-pass at 7.5 kHz: speech intelligibility lives below this; hiss & whines above
  for (const q of [0.51, 0.6, 0.9, 2.56]) nodes.push(bq('lowpass', 7500, q));

  nodes.push(bq('peaking', 250, 1, -2), bq('peaking', 3000, 1.2, 3));
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -30; comp.ratio.value = 3.5; comp.knee.value = 8;
  comp.attack.value = 0.01; comp.release.value = 0.25;
  const boost = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3; limiter.ratio.value = 20; limiter.knee.value = 0;
  limiter.attack.value = 0.002; limiter.release.value = 0.1;
  nodes.push(comp, boost, limiter);

  source.connect(nodes[0]);
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  const output = nodes[nodes.length - 1];

  // bypass routing
  let enabled = true;
  const route = (dest) => {
    try { output.disconnect(); } catch (e) {}
    try { source.disconnect(dest); } catch (e) {}
    (enabled ? output : source).connect(dest);
  };

  const set = (p) => {
    if (p.hiss !== undefined) den.port.postMessage({ strength: Math.max(0, Math.min(1, p.hiss / 100)) });
    if (p.boost !== undefined) boost.gain.value = Math.pow(10, (6 + Number(p.boost)) / 20); // base +6 dB makeup
  };
  set({ hiss: 75, boost: 3, ...params });

  // Auto-detect 50 vs 60 Hz mains once there is audio
  const buf = new Float32Array(analyser.frequencyBinCount), hz = sr / analyser.fftSize;
  const at = (f) => { const i = Math.round(f / hz); return Math.max(buf[i - 1], buf[i], buf[i + 1]); };
  let heard = 0;
  const iv = setInterval(() => {
    analyser.getFloatFrequencyData(buf);
    if (at(1000) < -120 && at(300) < -120) return; // nothing playing yet
    if (++heard < 5) return;
    const s50 = at(50) + at(100) + at(150) + at(250);
    const s60 = at(60) + at(120) + at(180) + at(300);
    if (s60 > s50 + 12) setMains(60);
    clearInterval(iv);
  }, 1000);

  const api = {
    connect: (dest) => { route(dest); return api; },
    set,
    setEnabled: (on, dest) => { enabled = on; route(dest); },
    get mains() { return mains; },
    stop: () => clearInterval(iv),
  };
  return api;
}
