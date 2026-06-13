/*
 * 墨流し (suminagashi) — interactive ink-marbling background for the hero.
 *
 * Shares the visual language of the pitch deck (landing/pitch): a single Jos Stam
 * "stable fluids" simulation whose velocity field advects three subtractive-ink
 * pigment channels (藍 indigo / 縹 blue / 緑青 green — the LP palette), so inks flow,
 * mix, and fade. Pointer movement over the hero injects ink; it is faint enough to
 * sit behind the headline without hurting readability.
 *
 * Cheap by construction: a coarse 96×96 grid blitted (bilinear-upscaled) onto the
 * hero canvas, paused whenever the hero scrolls out of view or the tab is hidden,
 * and asleep between gestures once the surface clears. Honors prefers-reduced-motion
 * (renders one static marble) and is purely decorative (aria-hidden).
 */
(() => {
  const canvas = document.querySelector(".ink-bg");
  if (!canvas?.getContext) return;

  const N = 96;
  const SIZE = (N + 2) * (N + 2);
  const IX = (i, j) => i + (N + 2) * j;

  const u = new Float32Array(SIZE);
  const v = new Float32Array(SIZE);
  const uF = new Float32Array(SIZE);
  const vF = new Float32Array(SIZE);
  const tA = new Float32Array(SIZE);
  const tB = new Float32Array(SIZE);
  // Three pigment channels matched to the LP palette (--ink / --blue / --green).
  const INKS = [
    { a: new Float32Array(SIZE), s: new Float32Array(SIZE), c: [7, 17, 31] },
    { a: new Float32Array(SIZE), s: new Float32Array(SIZE), c: [9, 105, 218] },
    { a: new Float32Array(SIZE), s: new Float32Array(SIZE), c: [0, 138, 85] },
  ];
  const DT = 0.18;
  const VISC = 0.00003;
  const ITER = 8;
  const DISS = 0.991; // ink longevity (lower = fades faster)
  const ALPHA = 0.42; // max opacity over the light hero — keep text readable

  function setBnd(b, x) {
    for (let i = 1; i <= N; i++) {
      x[IX(0, i)] = b === 1 ? -x[IX(1, i)] : x[IX(1, i)];
      x[IX(N + 1, i)] = b === 1 ? -x[IX(N, i)] : x[IX(N, i)];
      x[IX(i, 0)] = b === 2 ? -x[IX(i, 1)] : x[IX(i, 1)];
      x[IX(i, N + 1)] = b === 2 ? -x[IX(i, N)] : x[IX(i, N)];
    }
    x[IX(0, 0)] = 0.5 * (x[IX(1, 0)] + x[IX(0, 1)]);
    x[IX(0, N + 1)] = 0.5 * (x[IX(1, N + 1)] + x[IX(0, N)]);
    x[IX(N + 1, 0)] = 0.5 * (x[IX(N, 0)] + x[IX(N + 1, 1)]);
    x[IX(N + 1, N + 1)] = 0.5 * (x[IX(N, N + 1)] + x[IX(N + 1, N)]);
  }
  function linSolve(b, x, x0, a, c) {
    const cR = 1 / c;
    for (let k = 0; k < ITER; k++) {
      for (let j = 1; j <= N; j++)
        for (let i = 1; i <= N; i++) {
          x[IX(i, j)] =
            (x0[IX(i, j)] +
              a * (x[IX(i - 1, j)] + x[IX(i + 1, j)] + x[IX(i, j - 1)] + x[IX(i, j + 1)])) *
            cR;
        }
      setBnd(b, x);
    }
  }
  function clampToGrid(x) {
    if (x < 0.5) return 0.5;
    if (x > N + 0.5) return N + 0.5;
    return x;
  }
  function sampleBilinear(d0, x, y) {
    const i0 = x | 0;
    const j0 = y | 0;
    const s1 = x - i0;
    const t1 = y - j0;
    const s0 = 1 - s1;
    const t0 = 1 - t1;
    return (
      s0 * (t0 * d0[IX(i0, j0)] + t1 * d0[IX(i0, j0 + 1)]) +
      s1 * (t0 * d0[IX(i0 + 1, j0)] + t1 * d0[IX(i0 + 1, j0 + 1)])
    );
  }
  function advect(b, d, d0, uu, vv) {
    const dt0 = DT * N;
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) {
        const x = clampToGrid(i - dt0 * uu[IX(i, j)]);
        const y = clampToGrid(j - dt0 * vv[IX(i, j)]);
        d[IX(i, j)] = sampleBilinear(d0, x, y);
      }
    setBnd(b, d);
  }
  function project() {
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) {
        tB[IX(i, j)] =
          (-0.5 * (u[IX(i + 1, j)] - u[IX(i - 1, j)] + v[IX(i, j + 1)] - v[IX(i, j - 1)])) / N;
        tA[IX(i, j)] = 0;
      }
    setBnd(0, tB);
    setBnd(0, tA);
    linSolve(0, tA, tB, 1, 4);
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) {
        u[IX(i, j)] -= 0.5 * N * (tA[IX(i + 1, j)] - tA[IX(i - 1, j)]);
        v[IX(i, j)] -= 0.5 * N * (tA[IX(i, j + 1)] - tA[IX(i, j - 1)]);
      }
    setBnd(1, u);
    setBnd(2, v);
  }
  let mass = 0;
  function step() {
    for (let i = 0; i < SIZE; i++) {
      u[i] += DT * uF[i];
      v[i] += DT * vF[i];
    }
    uF.fill(0);
    vF.fill(0);
    tA.set(u);
    linSolve(1, u, tA, DT * VISC * N * N, 1 + 4 * DT * VISC * N * N);
    tB.set(v);
    linSolve(2, v, tB, DT * VISC * N * N, 1 + 4 * DT * VISC * N * N);
    project();
    tA.set(u);
    tB.set(v);
    advect(1, u, tA, tA, tB);
    advect(2, v, tB, tA, tB);
    project();
    mass = 0;
    for (const ink of INKS) {
      for (let i = 0; i < SIZE; i++) ink.a[i] += DT * ink.s[i];
      ink.s.fill(0);
      tA.set(ink.a);
      advect(0, ink.a, tA, u, v);
      for (let i = 0; i < SIZE; i++) {
        let av = ink.a[i] * DISS;
        if (av > 4) av = 4;
        ink.a[i] = av;
        mass += av;
      }
    }
  }

  const off = document.createElement("canvas");
  off.width = N;
  off.height = N;
  const octx = off.getContext("2d");
  const img = octx.createImageData(N, N);
  function paintOffscreen() {
    const d = img.data;
    let p = 0;
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) {
        const idx = IX(i, j);
        const a0 = INKS[0].a[idx];
        const a1 = INKS[1].a[idx];
        const a2 = INKS[2].a[idx];
        const t = a0 + a1 + a2;
        if (t > 0.001) {
          const inv = 1 / t;
          d[p] = (a0 * INKS[0].c[0] + a1 * INKS[1].c[0] + a2 * INKS[2].c[0]) * inv;
          d[p + 1] = (a0 * INKS[0].c[1] + a1 * INKS[1].c[1] + a2 * INKS[2].c[1]) * inv;
          d[p + 2] = (a0 * INKS[0].c[2] + a1 * INKS[1].c[2] + a2 * INKS[2].c[2]) * inv;
          let al = t * 0.5;
          if (al > ALPHA) al = ALPHA;
          d[p + 3] = al * 255;
        } else {
          d[p + 3] = 0;
        }
        p += 4;
      }
    octx.putImageData(img, 0, 0);
  }

  const ctx = canvas.getContext("2d");
  let cssW = 0;
  let cssH = 0;
  function resize() {
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(1, rect.width);
    cssH = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
  }
  function blit() {
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.drawImage(off, 0, 0, N, N, 0, 0, cssW, cssH);
  }

  let inkRotation = 0;
  function inject(gx, gy, dgx, dgy, amount, r) {
    // gold is reserved for the deck; here cycle ink → blue → green for variety
    const ink = INKS[inkRotation % 3];
    inkRotation++;
    const cx = (gx | 0) + 1;
    const cy = (gy | 0) + 1;
    const r2 = r * r;
    for (let jj = -r; jj <= r; jj++)
      for (let ii = -r; ii <= r; ii++) {
        const x = cx + ii;
        const y = cy + jj;
        if (x < 1 || x > N || y < 1 || y > N) continue;
        const d2 = ii * ii + jj * jj;
        if (d2 > r2) continue;
        const f = Math.exp(-d2 / (r2 + 0.001));
        const idx = IX(x, y);
        uF[idx] += dgx * 14 * f;
        vF[idx] += dgy * 14 * f;
        ink.s[idx] += amount * f;
      }
  }

  let running = false;
  let idleFrames = 0;
  let visible = true;
  function frame() {
    step();
    paintOffscreen();
    blit();
    if ((mass < 12 && ++idleFrames > 80) || !visible) {
      running = false;
      return;
    }
    requestAnimationFrame(frame);
  }
  function wake() {
    idleFrames = 0;
    if (!running && visible) {
      running = true;
      requestAnimationFrame(frame);
    }
  }

  function seed(strength) {
    for (let i = 0; i < 5; i++) {
      inject(
        8 + Math.random() * (N - 16),
        8 + Math.random() * (N - 16),
        (Math.random() - 0.5) * 1.6,
        (Math.random() - 0.5) * 1.6,
        strength,
        5,
      );
    }
  }

  resize();
  window.addEventListener("resize", resize, { passive: true });

  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    // Static single marble: seed, settle, paint once.
    seed(2.2);
    for (let s = 0; s < 50; s++) step();
    paintOffscreen();
    blit();
    return;
  }

  // Pause the loop whenever the hero scrolls out of view (cheap when unseen).
  if (window.IntersectionObserver) {
    new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      if (visible && mass >= 12) wake();
    }).observe(canvas);
  }

  seed(2.6);
  wake();

  setInterval(() => {
    if (document.visibilityState !== "visible" || !visible) return;
    inject(
      8 + Math.random() * (N - 16),
      8 + Math.random() * (N - 16),
      (Math.random() - 0.5) * 1.2,
      (Math.random() - 0.5) * 1.2,
      1.5,
      4,
    );
    wake();
  }, 7000);

  let lx = null;
  let ly = null;
  window.addEventListener(
    "pointermove",
    (e) => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const gx = ((e.clientX - rect.left) / rect.width) * N;
      const gy = ((e.clientY - rect.top) / rect.height) * N;
      if (gx < 0 || gx > N || gy < 0 || gy > N) {
        lx = null;
        return;
      }
      let dgx = 0;
      let dgy = 0;
      if (lx !== null) {
        dgx = ((e.clientX - lx) / rect.width) * N;
        dgy = ((e.clientY - ly) / rect.height) * N;
        if (dgx * dgx + dgy * dgy < 0.04) return;
      }
      lx = e.clientX;
      ly = e.clientY;
      inject(gx, gy, dgx, dgy, 0.9, 3);
      wake();
    },
    { passive: true },
  );
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && mass >= 12) wake();
  });
})();
