// Real-time spectral hiss reduction (STFT, 75% overlap, minimum-statistics noise tracking).
// Output is mono (lecture speech), duplicated to all output channels.

class FFT {
  constructor(n) {
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }
  // in-place; inverse=true computes unscaled inverse
  run(re, im, inverse) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step], wi = sgn * this.sin[k * step];
          const a = start + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

class Denoiser extends AudioWorkletProcessor {
  constructor() {
    super();
    const N = (this.N = 1024), H = (this.H = 256), B = N / 2 + 1;
    this.fft = new FFT(N);
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    this.inBuf = new Float32Array(N);
    this.olaBuf = new Float32Array(N);
    this.outBlock = new Float32Array(H);
    this.count = 0;
    this.re = new Float32Array(N);
    this.im = new Float32Array(N);
    this.psmooth = new Float32Array(B);
    this.pnoise = new Float32Array(B);
    this.noise = new Float32Array(B).fill(1e9);
    // Windowed minimum (~2.4 s) via U sub-windows of V frames each
    this.U = 8; this.V = Math.round((2.4 * sampleRate) / H / this.U);
    this.subMins = Array.from({ length: this.U }, () => new Float32Array(B).fill(1e9));
    this.curMin = new Float32Array(B).fill(1e9);
    this.vCount = 0; this.uIdx = 0; this.started = false;
    this.gain = new Float32Array(B).fill(1);
    this.g = new Float32Array(B);
    this.strength = 0.8;   // 0..1
    this.enabled = true;
    this.bias = 2.2; this.over = 1.0;
    this.port.onmessage = (e) => {
      if ('strength' in e.data) this.strength = e.data.strength;
      if ('enabled' in e.data) this.enabled = e.data.enabled;
      if ('bias' in e.data) this.bias = e.data.bias;
    };
  }

  frame() {
    const { N, re, im, win, psmooth, pnoise, noise, gain, g } = this;
    const B = N / 2 + 1;
    let energy = 0, run = 0, gap = false;
    for (let i = 0; i < N; i++) {
      const v = this.inBuf[i];
      re[i] = v * win[i]; im[i] = 0; energy += re[i] * re[i];
      run = Math.abs(v) < 1e-6 ? run + 1 : 0;   // digital silence (paused / muted / gaps)
      if (run >= 32) gap = true;
    }
    this.fft.run(re, im, false);

    const s = this.strength;
    // ignore digital silence and fades: frames >35 dB below the running level
    this.lt = this.lt === undefined ? energy : 0.995 * this.lt + 0.005 * energy;
    const silent = gap || energy < 1e-10 || energy < this.lt * 3e-5;
    for (let k = 0; k < B; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      psmooth[k] = 0.6 * psmooth[k] + 0.4 * p;           // for the gain (responsive)
      if (!silent) {
        pnoise[k] = this.started ? 0.92 * pnoise[k] + 0.08 * p : p;  // for noise tracking (stable)
        if (pnoise[k] < this.curMin[k]) this.curMin[k] = pnoise[k];
        let m = this.curMin[k];
        for (let u = 0; u < this.U; u++) if (this.subMins[u][k] < m) m = this.subMins[u][k];
        noise[k] = m;
      }
      // bias compensates for minimum statistics sitting below the mean noise level
      const ratio = (this.bias * noise[k]) / (psmooth[k] + 1e-20);
      const floor = Math.pow(10, (-24 * s) / 20);  // strength 1 -> -24 dB floor
      let gk = 1 - this.over * (0.5 + s) * ratio;
      if (gk < floor) gk = floor;
      g[k] = gk;
    }
    if (!silent) {
      this.started = true;
      if (++this.vCount >= this.V) {           // rotate sub-window
        this.vCount = 0;
        this.subMins[this.uIdx].set(this.curMin);
        this.uIdx = (this.uIdx + 1) % this.U;
        this.curMin.fill(1e9);
      }
    }
    // smooth across frequency, then over time (fast attack, slower release) to avoid "musical noise"
    for (let k = 0; k < B; k++) {
      const a = g[k > 0 ? k - 1 : k], b = g[k], c = g[k < B - 1 ? k + 1 : k];
      const gs = 0.25 * a + 0.5 * b + 0.25 * c;
      gain[k] = gs > gain[k] ? 0.6 * gs + 0.4 * gain[k] : 0.3 * gs + 0.7 * gain[k];
    }
    for (let k = 0; k < B; k++) {
      re[k] *= gain[k]; im[k] *= gain[k];
      if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    this.fft.run(re, im, true);
    // Hann analysis + Hann synthesis at 75% overlap sums to 1.5
    const scale = 1 / (N * 1.5);
    for (let i = 0; i < N; i++) this.olaBuf[i] += re[i] * win[i] * scale;
  }

  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!out || !out.length) return true;
    const len = out[0].length;
    if (!inp || !inp.length) { for (const ch of out) ch.fill(0); return true; }
    const nIn = inp.length;
    const { N, H } = this;
    const o0 = out[0];
    for (let i = 0; i < len; i++) {
      let x = 0;
      for (let c = 0; c < nIn; c++) x += inp[c][i];
      x /= nIn;
      this.inBuf[N - H + this.count] = x;
      o0[i] = this.enabled ? this.outBlock[this.count] : this.inBuf[N - 2 * H + this.count];
      if (++this.count === H) {
        this.count = 0;
        this.frame();
        this.outBlock.set(this.olaBuf.subarray(0, H));
        this.olaBuf.copyWithin(0, H); this.olaBuf.fill(0, N - H);
        this.inBuf.copyWithin(0, H);
      }
    }
    for (let c = 1; c < out.length; c++) out[c].set(o0);
    return true;
  }
}

registerProcessor('lecture-denoiser', Denoiser);
