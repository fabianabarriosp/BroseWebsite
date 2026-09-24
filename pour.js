/* ------------------------------------------------------------------
   Brosé — scroll-driven rosé pour
   One normalized progress value (0..1), scrubbed by GSAP ScrollTrigger,
   drives every element of the scene. Time is only used for secondary
   motion (liquid wobble, ripples, particles), never for the timeline.
------------------------------------------------------------------- */
(() => {
  'use strict';

  const section = document.getElementById('pour');
  if (!section) return;
  const stage = section.querySelector('.pour__stage');
  const canvas = section.querySelector('.pour__canvas');
  const ctx = canvas.getContext('2d');
  const introEl = section.querySelector('.pour__copy--intro');
  const hintEl = section.querySelector('.pour__hint');
  const outroEl = section.querySelector('.pour__copy--outro');
  const grainEl = section.querySelector('.pour__grain');

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------------------------------------------
     math
  --------------------------------------------------------------- */
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  };
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const DEG = Math.PI / 180;

  // Cubic Hermite through keyframes with non-uniform spacing.
  // Tangents are zeroed at local extrema so values never overshoot.
  function makeTrack(keys) {
    const n = keys.length;
    const dims = keys[0].v.length;
    const m = keys.map((k, i) => {
      const out = new Array(dims).fill(0);
      if (i === 0 || i === n - 1) return out;
      const a = keys[i - 1], b = keys[i + 1];
      for (let d = 0; d < dims; d++) {
        const s0 = (k.v[d] - a.v[d]) / (k.p - a.p);
        const s1 = (b.v[d] - k.v[d]) / (b.p - k.p);
        out[d] = s0 * s1 <= 0 ? 0 : (b.v[d] - a.v[d]) / (b.p - a.p);
      }
      return out;
    });
    return (p, out) => {
      p = clamp(p, keys[0].p, keys[n - 1].p);
      let i = 0;
      while (i < n - 2 && p > keys[i + 1].p) i++;
      const k0 = keys[i], k1 = keys[i + 1];
      const h = k1.p - k0.p;
      const t = (p - k0.p) / h;
      const t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      for (let d = 0; d < dims; d++) {
        out[d] = h00 * k0.v[d] + h10 * h * m[i][d] + h01 * k1.v[d] + h11 * h * m[i + 1][d];
      }
      return out;
    };
  }

  // Resample a profile [[t, r], ...] with Catmull-Rom into n points.
  function sampleProfile(pts, n) {
    const out = [];
    const segs = pts.length - 1;
    for (let i = 0; i <= n; i++) {
      const f = (i / n) * segs;
      const s = Math.min(segs - 1, Math.floor(f));
      const u = f - s;
      const p0 = pts[Math.max(0, s - 1)], p1 = pts[s], p2 = pts[s + 1], p3 = pts[Math.min(segs, s + 2)];
      const cr = (a, b, c, d) =>
        0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);
      out.push([cr(p0[0], p1[0], p2[0], p3[0]), Math.max(0, cr(p0[1], p1[1], p2[1], p3[1]))]);
    }
    return out;
  }

  /* ---------------------------------------------------------------
     the choreography — every key is a function of progress p
  --------------------------------------------------------------- */
  // bottle mouth position (x from glass centre, y from rim, both in S units) and tilt in degrees
  // tilt 0 = upright, 90 = horizontal with the mouth pointing left, >90 = mouth dipping down
  const bottleTrack = makeTrack([
    { p: 0.00, v: [1.10, -0.66, 36] },
    { p: 0.07, v: [0.80, -0.52, 38] },
    { p: 0.20, v: [0.46, -0.40, 44] },
    { p: 0.30, v: [0.28, -0.33, 74] },
    { p: 0.37, v: [0.20, -0.27, 99] },
    { p: 0.46, v: [0.19, -0.24, 107] },
    { p: 0.60, v: [0.19, -0.23, 114] },
    { p: 0.72, v: [0.19, -0.23, 121] },
    { p: 0.80, v: [0.22, -0.28, 97] },
    { p: 0.90, v: [0.40, -0.44, 62] },
    { p: 1.00, v: [1.15, -0.82, 40] },
  ]);

  // how open the pour is, before rate modulation
  const pourWindow = (p) => smooth(0.345, 0.395, p) * (1 - smooth(0.695, 0.775, p));
  // how strongly the bottle is aimed at the glass (the pose blends to a computed aim)
  const aimWeight = (p) => smooth(0.3, 0.37, p) * (1 - smooth(0.76, 0.86, p));

  // glass fill follows the integral of the pour window, so the level only rises while wine flows
  const FILL_MAX = 0.86;
  const FILL_LAG = 0.012;
  const fillTable = (() => {
    const N = 400, t = new Float32Array(N + 1);
    let acc = 0;
    for (let i = 1; i <= N; i++) {
      acc += pourWindow((i - 0.5) / N);
      t[i] = acc;
    }
    for (let i = 0; i <= N; i++) t[i] /= acc;
    return t;
  })();
  const fillAt = (p) => {
    const x = clamp(p - FILL_LAG) * 400;
    const i = Math.min(399, Math.floor(x));
    return FILL_MAX * lerp(fillTable[i], fillTable[i + 1], x - i);
  };

  const DRIP_POINTS = [0.785, 0.812, 0.848];

  /* ---------------------------------------------------------------
     layout
  --------------------------------------------------------------- */
  let W = 0, H = 0, DPR = 1, S = 1;
  let gx = 0, footY = 0, bowlBottomY = 0, rimY = 0;
  let R = 0, HB = 0, STEM = 0, FOOT_R = 0, BL = 0;
  let bowl = [];          // [{h, y, r}] from bowl bottom (h=0) to rim
  let bowlVol = [];       // cumulative volume per bowl sample
  let bgCanvas = null, vignetteCanvas = null, lionCanvas = null;
  let isMobile = false;
  let poseXScale = 1;

  const BOWL_PROFILE = [[0, 0], [0.035, 0.4], [0.1, 0.66], [0.22, 0.87], [0.4, 0.98], [0.55, 1.0], [0.72, 0.97], [0.88, 0.905], [1, 0.84]];
  function layout() {
    const rect = stage.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.max(1, Math.round(rect.height));
    isMobile = W < 720;
    DPR = Math.min(window.devicePixelRatio || 1, isMobile ? 1.75 : 2);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);

    const portrait = W < H;
    S = Math.min(W * (portrait ? 1.4 : 0.9), H * (portrait ? 0.62 : 1)) * 0.92;
    // narrow screens: pull the bottle's off-centre keyframes inwards so it stays in frame
    poseXScale = Math.pow(Math.min(1, (W * 0.5) / (0.62 * S)), 2);

    R = 0.125 * S;
    HB = 0.29 * S;
    STEM = 0.2 * S;
    FOOT_R = 0.105 * S;
    BL = 0.74 * S;

    gx = W * 0.5;
    footY = H * (portrait ? 0.8 : 0.885);
    bowlBottomY = footY - STEM - 0.012 * S;
    rimY = bowlBottomY - HB;

    bowl = sampleProfile(BOWL_PROFILE, 64).map(([u, r]) => ({ h: u * HB, y: bowlBottomY - u * HB, r: r * R }));
    bowlVol = [0];
    for (let i = 1; i < bowl.length; i++) {
      const a = bowl[i - 1], b = bowl[i];
      const rm = (a.r + b.r) / 2;
      bowlVol.push(bowlVol[i - 1] + Math.PI * rm * rm * (b.h - a.h));
    }


    buildBackground();
    buildGrain();
    initParticles();
    resetHistory();
  }

  /* ---------------------------------------------------------------
     pre-rendered layers
  --------------------------------------------------------------- */
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  const PAD = 60; // background overscan for parallax

  function buildBackground() {
    const w = (W + PAD * 2) * DPR, h = (H + PAD * 2) * DPR;
    bgCanvas = makeCanvas(w, h);
    const b = bgCanvas.getContext('2d');
    b.scale(DPR, DPR);
    const cx = PAD + gx, cy = PAD + rimY + 0.05 * S;
    const big = Math.hypot(W, H);

    b.fillStyle = '#000';
    b.fillRect(0, 0, W + PAD * 2, H + PAD * 2);

    // #E10808 light spilling from behind the glass into black
    let g = b.createRadialGradient(cx, cy, 0, cx, cy, big * 0.62);
    g.addColorStop(0, 'rgba(225,8,8,0.62)');
    g.addColorStop(0.22, 'rgba(170,4,6,0.42)');
    g.addColorStop(0.5, 'rgba(70,0,2,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    b.fillStyle = g;
    b.fillRect(0, 0, W + PAD * 2, H + PAD * 2);

    // faint cool key light from above-left, so the chrome has something to catch
    g = b.createRadialGradient(PAD + W * 0.25, PAD - H * 0.15, 0, PAD + W * 0.25, PAD - H * 0.15, big * 0.55);
    g.addColorStop(0, 'rgba(255,235,235,0.06)');
    g.addColorStop(1, 'rgba(255,235,235,0)');
    b.fillStyle = g;
    b.fillRect(0, 0, W + PAD * 2, H + PAD * 2);

    // studio floor: fall off to black under the glass
    const fy = PAD + footY;
    g = b.createLinearGradient(0, fy - 0.16 * S, 0, fy + 0.32 * S);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.3)');
    g.addColorStop(1, 'rgba(0,0,0,0.7)');
    b.fillStyle = g;
    b.fillRect(0, fy - 0.16 * S, W + PAD * 2, H + PAD * 2);

    // hot core directly behind the bowl
    g = b.createRadialGradient(cx, cy, 0, cx, cy, S * 0.36);
    g.addColorStop(0, 'rgba(255,40,30,0.28)');
    g.addColorStop(1, 'rgba(255,40,30,0)');
    b.fillStyle = g;
    b.fillRect(0, 0, W + PAD * 2, H + PAD * 2);

    vignetteCanvas = makeCanvas(W * DPR, H * DPR);
    const v = vignetteCanvas.getContext('2d');
    v.scale(DPR, DPR);
    g = v.createRadialGradient(W / 2, H * 0.48, Math.min(W, H) * 0.35, W / 2, H * 0.5, big * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.78)');
    v.fillStyle = g;
    v.fillRect(0, 0, W, H);

    buildLion();
  }

  const lionImg = new Image();
  lionImg.decoding = 'async';
  lionImg.onload = () => { buildLion(); };
  lionImg.src = 'assets/Group%20248%20(1).png';

  function buildLion() {
    if (!lionImg.complete || !lionImg.naturalWidth || !W) { lionCanvas = null; return; }
    const lw = Math.min(W * 1.05, S * 1.9);
    const lh = lw * (lionImg.naturalHeight / lionImg.naturalWidth);
    lionCanvas = makeCanvas(lw * DPR, lh * DPR);
    const l = lionCanvas.getContext('2d');
    l.drawImage(lionImg, 0, 0, lionCanvas.width, lionCanvas.height);
    l.globalCompositeOperation = 'source-in';
    l.fillStyle = '#ff3b30';
    l.fillRect(0, 0, lionCanvas.width, lionCanvas.height);
  }

  // soft bokeh sprite and a four-point star sprite
  const dotSprite = (() => {
    const c = makeCanvas(64, 64), d = c.getContext('2d');
    const g = d.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,220,214,1)');
    g.addColorStop(0.25, 'rgba(255,90,80,0.5)');
    g.addColorStop(1, 'rgba(225,8,8,0)');
    d.fillStyle = g;
    d.fillRect(0, 0, 64, 64);
    return c;
  })();
  const starSprite = (() => {
    const c = makeCanvas(64, 64), d = c.getContext('2d');
    const g = d.createRadialGradient(32, 32, 0, 32, 32, 16);
    g.addColorStop(0, 'rgba(255,90,80,0.7)');
    g.addColorStop(1, 'rgba(225,8,8,0)');
    d.fillStyle = g;
    d.fillRect(0, 0, 64, 64);
    d.fillStyle = 'rgba(255,244,240,1)';
    d.beginPath();
    d.moveTo(32, 2);
    d.quadraticCurveTo(34, 30, 62, 32);
    d.quadraticCurveTo(34, 34, 32, 62);
    d.quadraticCurveTo(30, 34, 2, 32);
    d.quadraticCurveTo(30, 30, 32, 2);
    d.fill();
    return c;
  })();

  function buildGrain() {
    if (!grainEl || grainEl.dataset.ready) return;
    const c = makeCanvas(160, 160), d = c.getContext('2d');
    const img = d.createImageData(160, 160);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    d.putImageData(img, 0, 0);
    grainEl.style.backgroundImage = `url(${c.toDataURL()})`;
    grainEl.dataset.ready = '1';
  }

  /* ---------------------------------------------------------------
     particles & stars (deterministic seeds, parallax by depth)
  --------------------------------------------------------------- */
  let motes = [], stars = [];
  function rng(seed) {
    return () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
  }
  function initParticles() {
    const r = rng(7);
    const count = isMobile ? 38 : 70;
    motes = Array.from({ length: count }, () => ({
      x: r(), y: r(), z: 0.15 + r() * 0.85, s: 0.5 + r(), ph: r() * 6.28, sp: 0.2 + r() * 0.5,
    }));
    const r2 = rng(41);
    stars = Array.from({ length: isMobile ? 10 : 16 }, () => {
      let x = r2();
      if (Math.abs(x - 0.5) < 0.16) x += x < 0.5 ? -0.16 : 0.16; // keep the centre clean
      return { x, y: 0.06 + r2() * 0.62, z: 0.3 + r2() * 0.7, s: 0.5 + r2(), ph: r2() * 6.28, sp: 0.6 + r2() * 1.2 };
    });
  }

  /* ---------------------------------------------------------------
     live state
  --------------------------------------------------------------- */
  const driver = { p: 0 };
  let prevP = 0;
  let pSpeed = 0;           // smoothed |dp/dt|
  let rateBoost = 0.65;
  let time = 0;
  let lastNow = 0;

  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

  // bottle
  const pose = [0, 0, 0];
  let mouthX = 0, mouthY = 0, tilt = 0, prevTilt = 0;
  let mouthVX = 0, mouthVY = 0;
  let tiltVel = 0;
  let bottleSlosh = 0, bottleSloshV = 0;

  // glass liquid
  let surfTilt = 0, surfTiltV = 0;
  let ripples = [];
  let splash = [];
  let bubbles = [];
  let drops = [];
  let lastRippleT = 0;
  let impact = null;

  // stream history: every frame we record what the mouth was doing
  let hist = [];
  const HIST_SPAN = 1.0;

  function resetHistory() { hist = []; }

  function flowAt(p, tiltDeg) {
    return pourWindow(p) * smooth(90, 99, tiltDeg) * rateBoost;
  }

  function pushHistory(t, flow) {
    const a = -tilt * DEG;
    const dx = Math.sin(a), dy = -Math.cos(a); // mouth direction
    // wine leaves from the lower side of the lip
    let nx = -dy, ny = dx;
    if (ny < 0) { nx = -nx; ny = -ny; }
    const lip = LIP_R * BL;
    const entry = { t, x: mouthX + nx * lip * 0.7, y: mouthY + ny * lip * 0.7, dx, dy, vx: mouthVX, vy: mouthVY, f: flow };
    if (!hist.length || t - hist[hist.length - 1].t > 0.25) {
      // no recent history (first frame, resumed tab, resize): assume steady state
      hist = [{ ...entry, t: t - HIST_SPAN }, entry];
    } else {
      hist.push(entry);
    }
    while (hist.length > 2 && hist[1].t < t - HIST_SPAN) hist.shift();
  }

  const histTmp = { x: 0, y: 0, dx: 0, dy: 0, vx: 0, vy: 0, f: 0 };
  function histAt(t) {
    const n = hist.length;
    if (t <= hist[0].t) return Object.assign(histTmp, hist[0]);
    if (t >= hist[n - 1].t) return Object.assign(histTmp, hist[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (hist[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = hist[lo], b = hist[hi];
    const u = (t - a.t) / (b.t - a.t || 1);
    histTmp.x = lerp(a.x, b.x, u); histTmp.y = lerp(a.y, b.y, u);
    histTmp.dx = lerp(a.dx, b.dx, u); histTmp.dy = lerp(a.dy, b.dy, u);
    histTmp.vx = lerp(a.vx, b.vx, u); histTmp.vy = lerp(a.vy, b.vy, u);
    histTmp.f = lerp(a.f, b.f, u);
    return histTmp;
  }

  /* ---------------------------------------------------------------
     glass helpers
  --------------------------------------------------------------- */
  function bowlRadiusAtH(h) {
    if (h <= 0) return 0;
    if (h >= HB) return bowl[bowl.length - 1].r;
    const f = (h / HB) * (bowl.length - 1);
    const i = Math.floor(f);
    return lerp(bowl[i].r, bowl[i + 1].r, f - i);
  }
  function heightForVolumeFrac(frac) {
    const target = frac * bowlVol[bowlVol.length - 1];
    for (let i = 1; i < bowlVol.length; i++) {
      if (bowlVol[i] >= target) {
        const u = (target - bowlVol[i - 1]) / (bowlVol[i] - bowlVol[i - 1] || 1);
        return lerp(bowl[i - 1].h, bowl[i].h, u);
      }
    }
    return HB;
  }
  // perspective squash of horizontal circles: lower circles look slightly rounder
  const ellK = (h) => 0.15 + (1 - h / HB) * 0.045;

  // vertical surface displacement at a point on the surface plane (sx, sz from centre)
  function surfaceDisp(sx, sz) {
    let d = surfTilt * sx;
    for (let i = 0; i < ripples.length; i++) {
      const rp = ripples[i];
      const age = time - rp.t0;
      const dist = Math.hypot(sx - rp.x, sz - rp.z);
      const front = age * rp.c;
      if (dist > front) continue;
      d += rp.a * Math.exp(-age * 2.6) * Math.exp(-(front - dist) / (0.05 * S)) * Math.sin(dist * rp.k - age * 16);
    }
    return d;
  }

  // traced paths -----------------------------------------------------
  function bowlPath(c, g, inset = 0) {
    const x = gx + g.x;
    c.beginPath();
    for (let i = bowl.length - 1; i >= 0; i--) c.lineTo(x - Math.max(0, bowl[i].r - inset), g.y + bowl[i].y);
    for (let i = 0; i < bowl.length; i++) c.lineTo(x + Math.max(0, bowl[i].r - inset), g.y + bowl[i].y);
    c.closePath();
  }
  // bowl plus the space above the rim (for clipping splashes)
  function bowlAndAbovePath(c, g) {
    const x = gx + g.x;
    c.beginPath();
    const top = g.y + rimY - 0.3 * S;
    c.moveTo(x - bowl[bowl.length - 1].r, top);
    for (let i = bowl.length - 1; i >= 0; i--) c.lineTo(x - bowl[i].r, g.y + bowl[i].y);
    for (let i = 0; i < bowl.length; i++) c.lineTo(x + bowl[i].r, g.y + bowl[i].y);
    c.lineTo(x + bowl[bowl.length - 1].r, top);
    c.closePath();
  }

  /* ---------------------------------------------------------------
     frame
  --------------------------------------------------------------- */
  function update(dt, p) {
    // scroll speed drives how generously the bottle pours
    const inst = Math.abs(p - prevP) / Math.max(dt, 1e-3);
    pSpeed = lerp(pSpeed, inst, 1 - Math.exp(-dt / 0.18));
    rateBoost = lerp(rateBoost, 0.62 + 0.38 * clamp(pSpeed / 0.07), 1 - Math.exp(-dt / 0.3));

    pointer.x = lerp(pointer.x, pointer.tx, 1 - Math.exp(-dt / 0.6));
    pointer.y = lerp(pointer.y, pointer.ty, 1 - Math.exp(-dt / 0.6));

    // --- bottle pose
    bottleTrack(p, pose);
    const px = pose[0] > 0.19 ? 0.19 + (pose[0] - 0.19) * poseXScale : pose[0];
    let bx = gx + px * S + pointer.x * 10;
    const by = rimY + pose[1] * S + pointer.y * 6;
    tilt = pose[2];

    // aim: shift the mouth so the stream lands a touch left of centre
    const aw = aimWeight(p);
    if (aw > 0) {
      const a = -tilt * DEG;
      const dx = Math.sin(a), dy = -Math.cos(a);
      const v0 = 0.55 * S * 0.95;
      const g = 6.5 * S;
      const level = bowlBottomY - heightForVolumeFrac(fillAt(p));
      const fall = Math.max(10, level - by);
      const vy = dy * v0;
      const tl = (-vy + Math.sqrt(vy * vy + 2 * g * fall)) / g;
      const aimX = gx - 0.018 * S - dx * v0 * tl;
      bx = lerp(bx, aimX, aw);
    }

    const nvx = (bx - mouthX) / Math.max(dt, 1e-3);
    const nvy = (by - mouthY) / Math.max(dt, 1e-3);
    const first = mouthX === 0 && mouthY === 0;
    mouthVX = first ? 0 : lerp(mouthVX, clamp(nvx, -3 * S, 3 * S), 1 - Math.exp(-dt / 0.08));
    mouthVY = first ? 0 : lerp(mouthVY, clamp(nvy, -3 * S, 3 * S), 1 - Math.exp(-dt / 0.08));
    mouthX = bx; mouthY = by;

    const tv = first ? 0 : (tilt - prevTilt) / Math.max(dt, 1e-3);
    tiltVel = lerp(tiltVel, tv, 1 - Math.exp(-dt / 0.1));
    prevTilt = tilt;

    // wine inside the bottle lags the rotation a little
    bottleSloshV += (-90 * bottleSlosh - 7 * bottleSloshV - tiltVel * DEG * 0.9) * dt;
    bottleSlosh += bottleSloshV * dt;
    bottleSlosh = clamp(bottleSlosh, -0.35, 0.35);

    // --- stream
    const flow = flowAt(p, tilt);
    pushHistory(time, flow);

    // --- glass surface slosh
    const impactDrive = impact ? impact.vx / S * impact.f * 0.02 : 0;
    surfTiltV += (-70 * surfTilt - 3.2 * surfTiltV + impactDrive + (impact ? (Math.sin(time * 23) * 0.012 * impact.f) : 0)) * dt;
    surfTilt += surfTiltV * dt;
    surfTilt = clamp(surfTilt, -0.08, 0.08);

    // --- final drops leave the lip as the bottle lifts (only when scrolling forward)
    for (const dp of DRIP_POINTS) {
      if (prevP < dp && p >= dp) {
        const a = -tilt * DEG;
        drops.push({ x: mouthX + Math.sin(a) * 0.01 * S, y: mouthY + 0.006 * S, vx: Math.sin(a) * 0.08 * S + mouthVX * 0.4, vy: 0.05 * S, r: 0.0045 * S * (0.8 + Math.random() * 0.4) });
      }
    }
    if (p < DRIP_POINTS[0] - 0.02) drops.length = 0;

    // --- particles
    const g = 6.5 * S;
    for (let i = splash.length - 1; i >= 0; i--) {
      const s = splash[i];
      s.vy += g * 0.8 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
      s.life -= dt;
      if (s.life <= 0 || (s.vy > 0 && s.y > s.floor)) splash.splice(i, 1);
    }
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      b.y -= b.vs * dt;
      b.x += Math.sin(time * 9 + b.ph) * 0.02 * S * dt;
      b.life -= dt;
      if (b.life <= 0 || b.y < b.top) bubbles.splice(i, 1);
    }
    ripples = ripples.filter((r) => time - r.t0 < 1.6);

    prevP = p;
  }

  function spawnImpact(x, y, f, vx, level, dt) {
    const sx = x - gx;
    if (time - lastRippleT > 0.09 && f > 0.05) {
      ripples.push({ x: sx, z: (Math.random() - 0.5) * 0.01 * S, t0: time, a: 0.004 * S * f, k: 95 / S, c: 0.3 * S });
      if (ripples.length > 14) ripples.shift();
      lastRippleT = time;
    }
    if (reduceMotion) return;
    const n = f * 110 * dt + Math.random() * 0.6;
    for (let i = 0; i < n && splash.length < 50; i++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.8;
      const sp = (0.12 + Math.random() * 0.28) * S * (0.5 + f * 0.6);
      splash.push({ x: x + (Math.random() - 0.5) * 0.01 * S, y: y - 1, vx: Math.cos(ang) * sp + vx * 0.08, vy: Math.sin(ang) * sp, r: 0.8 + Math.random() * 1.8, life: 0.35 + Math.random() * 0.25, floor: y + 1 });
    }
    const nb = f * 22 * dt + Math.random() * 0.2;
    for (let i = 0; i < nb && bubbles.length < 40; i++) {
      bubbles.push({ x: x + (Math.random() - 0.5) * 0.03 * S, y: y + (0.015 + Math.random() * 0.06) * S, vs: (0.03 + Math.random() * 0.05) * S, r: 0.5 + Math.random() * 1.3, ph: Math.random() * 6, life: 1.4, top: level + 2 });
    }
  }

  function render(dt, p) {
    const c = ctx;
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;

    // ------------------------------------------------------------ background
    const bgx = -PAD - pointer.x * 12, bgy = -PAD - pointer.y * 8 + (0.5 - p) * 20;
    c.drawImage(bgCanvas, bgx, bgy, W + PAD * 2, H + PAD * 2);

    if (lionCanvas) {
      const lw = lionCanvas.width / DPR, lh = lionCanvas.height / DPR;
      c.globalAlpha = 0.035 + 0.02 * smooth(0.85, 1, p);
      c.drawImage(lionCanvas, gx - lw / 2 - pointer.x * 22, rimY - lh * 0.52 + (0.5 - p) * 0.12 * H - pointer.y * 12, lw, lh);
      c.globalAlpha = 1;
    }

    drawMotes(c, p, false);

    // ------------------------------------------------------------ camera
    const zoom = 1 + 0.06 * smooth(0.12, 0.55, p) - 0.035 * smooth(0.8, 1, p);
    const pivX = gx, pivY = rimY + 0.12 * S;
    c.setTransform(DPR * zoom, 0, 0, DPR * zoom, DPR * (pivX - pivX * zoom), DPR * (pivY - pivY * zoom));

    // glass entrance 0–20%
    const gIn = easeOutCubic(smooth(0.015, 0.2, p));
    const G = {
      x: pointer.x * 4,
      y: (1 - gIn) * 0.32 * S + (0.5 - p) * 0.012 * S + pointer.y * 3,
      a: gIn,
    };

    const fill = fillAt(p);
    const level = heightForVolumeFrac(fill);

    drawFloor(c, G, fill);
    drawBottle(c, p);
    drawGlassBack(c, G);
    if (fill > 0.0005) drawLiquid(c, G, level, fill);
    drawStream(c, dt, G, level);
    drawSplash(c, G, level);
    drawDrops(c, dt, G, level);
    drawGlassFront(c, G, fill);
    drawShine(c, G, level, p);

    // ------------------------------------------------------------ foreground
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    drawMotes(c, p, true);
    drawStars(c, p);
    c.drawImage(vignetteCanvas, 0, 0, W, H);
  }

  /* ---------------------------------------------------------------
     background particles
  --------------------------------------------------------------- */
  function drawMotes(c, p, near) {
    c.globalCompositeOperation = 'lighter';
    for (const m of motes) {
      if ((m.z > 0.82) !== near) continue;
      const drift = reduceMotion ? 0 : time * 0.006 * m.sp;
      let y = (m.y - p * 0.45 * m.z - drift) % 1;
      if (y < 0) y += 1;
      const x = m.x * W + Math.sin(time * 0.3 * m.sp + m.ph) * 14 * m.z - pointer.x * 34 * m.z;
      const yy = (y * 1.2 - 0.1) * H - pointer.y * 20 * m.z;
      const size = near ? (10 + m.s * 16) : (1.5 + m.z * 4.5) * m.s;
      const tw = 0.6 + 0.4 * Math.sin(time * 1.3 * m.sp + m.ph * 3);
      c.globalAlpha = near ? 0.05 * tw : (0.08 + 0.3 * m.z) * tw;
      c.drawImage(dotSprite, x - size, yy - size, size * 2, size * 2);
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }

  function drawStars(c, p) {
    c.globalCompositeOperation = 'lighter';
    for (const s of stars) {
      const x = s.x * W - pointer.x * 26 * s.z;
      const y = s.y * H - p * 0.12 * H * s.z - pointer.y * 14 * s.z;
      const tw = Math.pow(0.5 + 0.5 * Math.sin(time * s.sp + s.ph), 3);
      const size = (3 + s.s * 5) * (0.7 + 0.5 * tw);
      c.globalAlpha = (0.12 + 0.55 * tw) * (0.4 + 0.6 * s.z);
      c.drawImage(starSprite, x - size, y - size, size * 2, size * 2);
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }

  /* ---------------------------------------------------------------
     floor: shadow + light transmitted through the wine
  --------------------------------------------------------------- */
  function drawFloor(c, G, fill) {
    const x = gx + G.x, y = footY + G.y;
    c.save();
    c.globalAlpha = G.a;
    c.translate(x, y);
    c.scale(1, 0.18);
    let g = c.createRadialGradient(0, 0, 0, 0, 0, FOOT_R * 1.9);
    g.addColorStop(0, 'rgba(0,0,0,0.7)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.25)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(-FOOT_R * 2, -FOOT_R * 2, FOOT_R * 4, FOOT_R * 4);
    if (fill > 0.01) {
      c.globalCompositeOperation = 'lighter';
      g = c.createRadialGradient(FOOT_R * 0.35, FOOT_R * 0.4, 0, FOOT_R * 0.35, FOOT_R * 0.4, FOOT_R * 1.6);
      g.addColorStop(0, `rgba(225,8,8,${0.5 * fill})`);
      g.addColorStop(1, 'rgba(225,8,8,0)');
      c.fillStyle = g;
      c.fillRect(-FOOT_R * 2, -FOOT_R * 2, FOOT_R * 4.5, FOOT_R * 4.5);
    }
    c.restore();
  }

  /* ---------------------------------------------------------------
     bottle: the Brosé chrome bottle, cut from the product photo
     (assets/brose-bottle.webp) plus its spiked cork (assets/brose-cork.webp).
     Sprite coordinates below are in source pixels of those files.
  --------------------------------------------------------------- */
  const BOTTLE_SPRITE = { src: 'assets/brose-bottle.webp', lipX: 256, lipY: 33, length: 1518 };
  const CORK_SPRITE = { src: 'assets/brose-cork.webp', lipX: 138, lipY: 190 };
  const LIP_R = 0.055; // lip radius as a fraction of bottle length

  function loadSprite(src, onload) {
    const img = new Image();
    img.decoding = 'async';
    img.onload = onload;
    img.src = src;
    return img;
  }
  let bottleLit = null;
  const bottleImg = loadSprite(BOTTLE_SPRITE.src, () => { buildBottle(); });
  const corkImg = loadSprite(CORK_SPRITE.src);

  // bake the scene's red environment light into the chrome once
  function buildBottle() {
    if (!bottleImg.complete || !bottleImg.naturalWidth) return;
    const w = bottleImg.naturalWidth, h = bottleImg.naturalHeight;
    bottleLit = makeCanvas(w, h);
    const b = bottleLit.getContext('2d');
    b.drawImage(bottleImg, 0, 0);
    b.globalCompositeOperation = 'source-atop';
    // pull the studio-white chrome down so it sits in a dark room
    b.fillStyle = 'rgba(8,0,0,0.28)';
    b.fillRect(0, 0, w, h);
    // red bounce light on both flanks
    let g = b.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, 'rgba(225,8,8,0.55)');
    g.addColorStop(0.2, 'rgba(225,8,8,0.12)');
    g.addColorStop(0.5, 'rgba(225,8,8,0)');
    g.addColorStop(0.82, 'rgba(225,8,8,0.1)');
    g.addColorStop(1, 'rgba(225,8,8,0.45)');
    b.fillStyle = g;
    b.fillRect(0, 0, w, h);
    // fade into darkness toward the base
    g = b.createLinearGradient(0, h * 0.55, 0, h);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.35)');
    b.fillStyle = g;
    b.fillRect(0, 0, w, h);
  }

  function drawBottle(c, p) {
    const img = bottleLit || (bottleImg.complete && bottleImg.naturalWidth ? bottleImg : null);
    if (!img) return;
    const a = -tilt * DEG;
    const k = BL / BOTTLE_SPRITE.length;

    // skip when fully outside the frame
    const baseX = mouthX - BL * Math.sin(a), baseY = mouthY + BL * Math.cos(a);
    const pad = 0.2 * S;
    if (Math.min(mouthX, baseX) - pad > W || Math.min(mouthY, baseY) - pad > H || Math.max(mouthY, baseY) + pad < 0) return;

    c.save();
    c.translate(mouthX, mouthY);
    c.rotate(a);

    // cork: lifts straight out of the neck between 20% and 32%, reversible
    const lift = smooth(0.19, 0.31, p);
    const corkA = 1 - smooth(0.25, 0.32, p);
    if (corkA > 0.01 && corkImg.complete && corkImg.naturalWidth) {
      c.save();
      c.globalAlpha = corkA;
      c.translate(0, -lift * lift * 0.42 * BL);
      c.rotate(lift * -0.35);
      c.drawImage(corkImg, -CORK_SPRITE.lipX * k, -CORK_SPRITE.lipY * k, corkImg.naturalWidth * k, corkImg.naturalHeight * k);
      c.restore();
    }

    // soft shadow the bottle casts into the air (depth against the glow)
    c.save();
    c.globalAlpha = 0.5;
    const sg = c.createLinearGradient(-0.25 * BL, 0, 0.25 * BL, 0);
    sg.addColorStop(0, 'rgba(0,0,0,0)');
    sg.addColorStop(0.5, 'rgba(0,0,0,0.5)');
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = sg;
    c.fillRect(-0.25 * BL, 0.35 * BL, 0.5 * BL, 0.7 * BL);
    c.restore();

    c.drawImage(img, -BOTTLE_SPRITE.lipX * k, -BOTTLE_SPRITE.lipY * k, img.width * k, img.height * k);

    // a wet film of wine on the lip while pouring
    const wet = smooth(95, 104, tilt) * (1 - smooth(0.8, 0.9, p));
    if (wet > 0.01) {
      const lr = LIP_R * BL;
      c.globalAlpha = wet * 0.7;
      c.fillStyle = 'rgba(110,0,4,0.8)';
      c.beginPath();
      c.ellipse(0, 0.002 * BL, lr * 0.8, lr * 0.14, 0, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = 'rgba(255,120,110,0.6)';
      c.lineWidth = 1;
      c.beginPath();
      c.ellipse(0, 0.002 * BL, lr * 0.8, lr * 0.14, 0, Math.PI * 1.1, Math.PI * 1.7);
      c.stroke();
    }

    c.restore();
  }

  /* ---------------------------------------------------------------
     glass
  --------------------------------------------------------------- */
  function drawGlassBack(c, G) {
    if (G.a <= 0.001) return;
    c.save();
    c.globalAlpha = G.a;
    // faint body with fresnel-bright edges
    bowlPath(c, G);
    let g = c.createLinearGradient(gx + G.x - R, 0, gx + G.x + R, 0);
    g.addColorStop(0, 'rgba(255,238,238,0.13)');
    g.addColorStop(0.12, 'rgba(255,238,238,0.035)');
    g.addColorStop(0.5, 'rgba(255,238,238,0.012)');
    g.addColorStop(0.88, 'rgba(255,238,238,0.04)');
    g.addColorStop(1, 'rgba(255,238,238,0.15)');
    c.fillStyle = g;
    c.fill();
    // back half of the rim
    const top = bowl[bowl.length - 1];
    const k = ellK(HB);
    c.beginPath();
    c.ellipse(gx + G.x, G.y + top.y, top.r, top.r * k, 0, Math.PI, Math.PI * 2);
    c.strokeStyle = 'rgba(255,240,238,0.32)';
    c.lineWidth = 1;
    c.stroke();
    c.restore();
  }

  function drawLiquid(c, G, level, fill) {
    const cx = gx + G.x;
    const y0 = G.y + bowlBottomY - level;
    const r = Math.max(0.5, bowlRadiusAtH(level) - 1.2);
    const k = ellK(level);

    // surface outline points
    const N = 56;
    const sx = new Float32Array(N + 1), sy = new Float32Array(N + 1);
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * Math.PI * 2;
      const px = Math.cos(th) * r, pz = Math.sin(th) * r;
      sx[i] = cx + px;
      sy[i] = y0 + pz * k + surfaceDisp(px, pz);
    }

    c.save();
    c.globalAlpha = G.a;
    bowlPath(c, G, 1.2);
    c.clip();

    // body: front half of the surface down to the bowl bottom
    c.beginPath();
    for (let i = 0; i <= N / 2; i++) c.lineTo(sx[i], sy[i]);
    c.lineTo(cx - R * 1.2, G.y + bowlBottomY + 10);
    c.lineTo(cx + R * 1.2, G.y + bowlBottomY + 10);
    c.closePath();
    let g = c.createLinearGradient(cx - r, 0, cx + r, 0);
    // thick at the edges (near black), thin light path through the middle (#E10808)
    g.addColorStop(0, 'rgba(14,0,1,0.97)');
    g.addColorStop(0.12, 'rgba(80,0,4,0.93)');
    g.addColorStop(0.36, 'rgba(190,6,10,0.84)');
    g.addColorStop(0.55, 'rgba(225,8,8,0.8)');
    g.addColorStop(0.84, 'rgba(96,0,5,0.92)');
    g.addColorStop(1, 'rgba(12,0,1,0.97)');
    c.fillStyle = g;
    c.fill();

    // depth: deeper colour towards the bottom of the bowl
    g = c.createLinearGradient(0, y0, 0, G.y + bowlBottomY);
    g.addColorStop(0, 'rgba(10,0,1,0)');
    g.addColorStop(1, 'rgba(10,0,1,0.6)');
    c.fillStyle = g;
    c.fill();

    // caustic: light focused through the liquid
    c.globalCompositeOperation = 'lighter';
    const caY = G.y + bowlBottomY - level * 0.3;
    g = c.createRadialGradient(cx + r * 0.18, caY, 0, cx + r * 0.18, caY, r * 0.75);
    g.addColorStop(0, 'rgba(255,60,40,0.4)');
    g.addColorStop(1, 'rgba(255,60,40,0)');
    c.fillStyle = g;
    c.fill();

    // plume of lighter wine beneath the stream impact
    if (impact && impact.f > 0.02) {
      const ix = impact.x, iy = y0;
      const pr = (0.035 + 0.05 * impact.f) * S;
      c.save();
      c.translate(ix, iy + pr * 0.6);
      c.scale(0.55, 1);
      g = c.createRadialGradient(0, 0, 0, 0, 0, pr);
      g.addColorStop(0, `rgba(255,70,50,${0.35 * impact.f})`);
      g.addColorStop(1, 'rgba(255,70,50,0)');
      c.fillStyle = g;
      c.fillRect(-pr, -pr, pr * 2, pr * 2);
      c.restore();
    }

    // rising micro bubbles
    c.globalCompositeOperation = 'source-over';
    c.strokeStyle = 'rgba(255,170,160,0.55)';
    c.lineWidth = 0.6;
    for (const b of bubbles) {
      c.globalAlpha = G.a * clamp(b.life);
      c.beginPath();
      c.arc(b.x + G.x, b.y + G.y, b.r, 0, Math.PI * 2);
      c.stroke();
    }
    c.globalAlpha = G.a;

    // surface
    c.beginPath();
    for (let i = 0; i <= N; i++) c.lineTo(sx[i], sy[i]);
    c.closePath();
    g = c.createLinearGradient(0, y0 - r * k, 0, y0 + r * k);
    // the surface mirrors the glow behind (bright at the back) and the dark room in front
    g.addColorStop(0, 'rgba(210,24,24,0.95)');
    g.addColorStop(0.45, 'rgba(120,2,8,0.95)');
    g.addColorStop(1, 'rgba(48,0,3,0.96)');
    c.fillStyle = g;
    c.fill();

    c.save();
    c.clip();
    // soft studio reflection on the surface
    c.globalCompositeOperation = 'lighter';
    c.translate(cx - r * 0.25, y0 - r * k * 0.35);
    c.scale(1, k * 1.2);
    g = c.createRadialGradient(0, 0, 0, 0, 0, r * 0.6);
    g.addColorStop(0, 'rgba(255,190,180,0.4)');
    g.addColorStop(1, 'rgba(255,190,180,0)');
    c.fillStyle = g;
    c.fillRect(-r, -r, r * 2, r * 2);
    c.restore();

    // ripple rings
    c.save();
    c.beginPath();
    for (let i = 0; i <= N; i++) c.lineTo(sx[i], sy[i]);
    c.closePath();
    c.clip();
    c.lineWidth = 0.9;
    for (const rp of ripples) {
      const age = time - rp.t0;
      const rr = age * rp.c;
      const al = Math.exp(-age * 2.4) * clamp(rp.a / (0.0035 * S));
      if (al < 0.02 || rr < 1) continue;
      c.strokeStyle = `rgba(255,150,140,${0.55 * al})`;
      c.beginPath();
      c.ellipse(cx + rp.x, y0 + rp.z * k, rr, rr * k, 0, 0, Math.PI * 2);
      c.stroke();
    }
    // impact foam
    if (impact && impact.f > 0.02) {
      const fr = (0.018 + 0.024 * impact.f) * S;
      c.translate(impact.x, y0);
      c.scale(1, k * 1.4);
      g = c.createRadialGradient(0, 0, 0, 0, 0, fr);
      g.addColorStop(0, `rgba(255,140,120,${0.7 * impact.f})`);
      g.addColorStop(1, 'rgba(255,140,120,0)');
      c.fillStyle = g;
      c.fillRect(-fr, -fr, fr * 2, fr * 2);
    }
    c.restore();

    // meniscus: bright back edge, subtle front edge
    c.lineWidth = 1.1;
    c.strokeStyle = 'rgba(255,150,140,0.85)';
    c.beginPath();
    for (let i = N / 2; i <= N; i++) c.lineTo(sx[i], sy[i]);
    c.stroke();
    c.strokeStyle = 'rgba(255,70,60,0.45)';
    c.beginPath();
    for (let i = 0; i <= N / 2; i++) c.lineTo(sx[i], sy[i]);
    c.stroke();

    c.restore();
  }

  /* ---------------------------------------------------------------
     the stream: each point is a parcel of wine emitted in the past,
     flying on its own ballistic path — so the stream bends, stretches
     and detaches naturally as the bottle moves.
  --------------------------------------------------------------- */
  const SN = 56;
  const stX = new Float32Array(SN + 1), stY = new Float32Array(SN + 1), stW = new Float32Array(SN + 1);

  function drawStream(c, dt, G, level) {
    impact = null;
    if (!hist.length) return;
    const g = 6.5 * S;
    const baseW = 0.03 * S;
    const maxAge = 0.75;
    const surfY = G.y + bowlBottomY - level;
    const surfR = bowlRadiusAtH(level);
    const cx = gx + G.x;
    const now = time;

    let count = 0;
    let segsDrawn = 0;

    const flush = () => {
      if (count >= 2) { paintStreamSegment(c, count); segsDrawn++; }
      count = 0;
    };

    for (let i = 0; i <= SN; i++) {
      const a = (i / SN) * maxAge;
      const s = histAt(now - a);
      if (s.f < 0.012) { flush(); continue; }
      const sp0 = 0.55 * S * (0.45 + 0.55 * clamp(s.f));
      const vx = s.dx * sp0 + s.vx * 0.55;
      const vy = s.dy * sp0 + s.vy * 0.55;
      let x = s.x + vx * a;
      let y = s.y + vy * a + 0.5 * g * a * a;
      const speed = Math.hypot(vx, vy + g * a);

      // continuity: faster wine is thinner
      let w = baseW * Math.sqrt(clamp(s.f, 0, 1.2)) * Math.sqrt(sp0 / Math.max(speed, sp0));
      // surface tension: varicose wobble travelling with the flow
      const emitT = now - a;
      w *= 1 + 0.1 * Math.sin(emitT * 47) * smooth(0.02, 0.2, a);
      // low flow breaks into beads (Plateau–Rayleigh)
      const lowF = 1 - smooth(0.08, 0.4, s.f);
      if (lowF > 0) {
        const bead = Math.max(0, Math.sin(emitT * 62));
        w *= lerp(1, Math.pow(bead, 1.6) * 1.35, lowF * smooth(0.03, 0.18, a));
      }
      // slight lateral sway
      if (!reduceMotion) x += Math.sin(emitT * 13 + 1.7) * 0.0025 * S * smooth(0.05, 0.4, a);

      // landing on the wine (or the bottom of the empty bowl)
      const inside = Math.abs(x - cx) < surfR * 0.98 || (level < 1 && Math.abs(x - cx) < R * 0.3);
      const hitY = level < 1 ? G.y + bowlBottomY - 2 : surfY + surfaceDisp(x - cx, 0);
      if (inside && y >= hitY && count > 0) {
        // interpolate to the surface
        const px = stX[count - 1], py = stY[count - 1];
        const u = clamp((hitY - py) / (y - py || 1));
        stX[count] = lerp(px, x, u); stY[count] = hitY; stW[count] = w; count++;
        if (!impact || s.f > impact.f) impact = { x: stX[count - 1], y: hitY, f: clamp(s.f), vx };
        flush();
        break;
      }
      if (inside && y >= hitY) break;
      if (y > H * 1.3) { flush(); break; }
      stX[count] = x; stY[count] = y; stW[count] = w; count++;
    }
    flush();

    if (impact) spawnImpact(impact.x, impact.y, impact.f, impact.vx, surfY, dt);
    return segsDrawn;
  }

  function paintStreamSegment(c, n) {
    // edges
    const L = [], Rr = [];
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      let tx = stX[i1] - stX[i0], ty = stY[i1] - stY[i0];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      const hw = stW[i] * 0.5;
      L.push(stX[i] - ty * hw, stY[i] + tx * hw);
      Rr.push(stX[i] + ty * hw, stY[i] - tx * hw);
    }
    c.beginPath();
    c.moveTo(L[0], L[1]);
    for (let i = 1; i < n; i++) c.lineTo(L[i * 2], L[i * 2 + 1]);
    // rounded tail
    const e = n - 1;
    c.arc(stX[e], stY[e], Math.max(0.3, stW[e] * 0.5), Math.atan2(L[e * 2 + 1] - stY[e], L[e * 2] - stX[e]), Math.atan2(Rr[e * 2 + 1] - stY[e], Rr[e * 2] - stX[e]), false);
    for (let i = n - 1; i >= 0; i--) c.lineTo(Rr[i * 2], Rr[i * 2 + 1]);
    c.closePath();

    const mid = stW[Math.floor(n / 2)];
    // body: translucent, deep where the column is thick
    c.fillStyle = 'rgba(140,0,6,0.7)';
    c.fill();
    c.strokeStyle = 'rgba(20,0,1,0.6)';
    c.lineWidth = Math.max(0.8, mid * 0.18);
    c.stroke();

    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.globalCompositeOperation = 'lighter';
    // light passing straight through the thin centre of the column
    c.beginPath();
    for (let i = 0; i < n; i++) c.lineTo(stX[i], stY[i]);
    c.strokeStyle = 'rgba(225,8,8,0.55)';
    c.lineWidth = Math.max(0.6, mid * 0.5);
    c.stroke();
    // specular threads: a sharp one left of centre, a soft one on the right
    c.beginPath();
    for (let i = 0; i < n; i++) c.lineTo(lerp(stX[i], L[i * 2], 0.5), lerp(stY[i], L[i * 2 + 1], 0.5));
    c.strokeStyle = 'rgba(255,190,176,0.7)';
    c.lineWidth = Math.max(0.5, mid * 0.12);
    c.stroke();
    c.beginPath();
    for (let i = 0; i < n; i++) c.lineTo(lerp(stX[i], Rr[i * 2], 0.62), lerp(stY[i], Rr[i * 2 + 1], 0.62));
    c.strokeStyle = 'rgba(255,80,60,0.3)';
    c.lineWidth = Math.max(0.5, mid * 0.14);
    c.stroke();
    c.globalCompositeOperation = 'source-over';
    c.lineCap = 'butt';
  }

  function drawSplash(c, G, level) {
    if (!splash.length) return;
    c.save();
    c.globalAlpha = G.a;
    bowlAndAbovePath(c, G);
    c.clip();
    for (const s of splash) {
      c.globalAlpha = G.a * clamp(s.life / 0.3);
      c.fillStyle = 'rgba(190,6,12,0.92)';
      c.beginPath();
      c.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = 'rgba(255,170,160,0.85)';
      c.beginPath();
      c.arc(s.x - s.r * 0.3, s.y - s.r * 0.3, s.r * 0.35, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  function drawDrops(c, dt, G, level) {
    if (!drops.length) return;
    const g = 6.5 * S;
    const surfY = G.y + bowlBottomY - level;
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.vy += g * dt;
      d.x += d.vx * dt; d.y += d.vy * dt;
      if (d.y >= surfY && Math.abs(d.x - gx - G.x) < bowlRadiusAtH(level)) {
        ripples.push({ x: d.x - gx - G.x, z: 0, t0: time, a: 0.004 * S, k: 95 / S, c: 0.3 * S });
        for (let j = 0; j < 5; j++) {
          const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.4;
          const sp = (0.1 + Math.random() * 0.18) * S;
          splash.push({ x: d.x, y: surfY - 1, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: 0.6 + Math.random(), life: 0.4, floor: surfY + 1 });
        }
        drops.splice(i, 1);
        continue;
      }
      if (d.y > H + 20) { drops.splice(i, 1); continue; }
      // teardrop stretched along velocity
      const v = Math.hypot(d.vx, d.vy);
      c.save();
      c.translate(d.x, d.y);
      c.rotate(Math.atan2(d.vy, d.vx) - Math.PI / 2);
      c.scale(1, 1 + clamp(v / S) * 1.1);
      c.fillStyle = 'rgba(190,6,12,0.92)';
      c.beginPath();
      c.arc(0, 0, d.r, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = 'rgba(255,170,160,0.85)';
      c.beginPath();
      c.arc(-d.r * 0.3, -d.r * 0.2, d.r * 0.3, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
  }

  function drawGlassFront(c, G, fill) {
    if (G.a <= 0.001) return;
    const cx = gx + G.x;
    c.save();
    c.globalAlpha = G.a;

    // ------------ stem & foot
    const knobTop = G.y + bowlBottomY - 0.004 * S;
    const stemTop = G.y + bowlBottomY + 0.028 * S;
    const stemBot = G.y + footY - 0.012 * S;
    const sw = 0.0058 * S;

    // knob where the bowl meets the stem (solid glass)
    c.beginPath();
    c.moveTo(cx - 0.024 * S, knobTop);
    c.bezierCurveTo(cx - 0.02 * S, knobTop + 0.02 * S, cx - sw, stemTop - 0.008 * S, cx - sw, stemTop);
    c.lineTo(cx + sw, stemTop);
    c.bezierCurveTo(cx + sw, stemTop - 0.008 * S, cx + 0.02 * S, knobTop + 0.02 * S, cx + 0.024 * S, knobTop);
    c.closePath();
    let g = c.createLinearGradient(cx - 0.024 * S, 0, cx + 0.024 * S, 0);
    g.addColorStop(0, 'rgba(255,236,236,0.35)');
    g.addColorStop(0.35, `rgba(${Math.round(lerp(255, 225, fill))},${Math.round(lerp(236, 8, fill))},${Math.round(lerp(236, 8, fill))},${lerp(0.22, 0.45, fill).toFixed(2)})`);
    g.addColorStop(0.6, 'rgba(255,240,236,0.5)');
    g.addColorStop(1, 'rgba(255,236,236,0.3)');
    c.fillStyle = g;
    c.fill();

    // stem, flaring at the foot
    c.beginPath();
    c.moveTo(cx - sw, stemTop);
    c.bezierCurveTo(cx - sw * 0.75, lerp(stemTop, stemBot, 0.4), cx - sw * 0.8, lerp(stemTop, stemBot, 0.85), cx - sw * 2.6, stemBot);
    c.lineTo(cx + sw * 2.6, stemBot);
    c.bezierCurveTo(cx + sw * 0.8, lerp(stemTop, stemBot, 0.85), cx + sw * 0.75, lerp(stemTop, stemBot, 0.4), cx + sw, stemTop);
    c.closePath();
    g = c.createLinearGradient(cx - sw, 0, cx + sw, 0);
    g.addColorStop(0, 'rgba(255,232,232,0.4)');
    g.addColorStop(0.3, `rgba(${Math.round(lerp(90, 225, fill))},${Math.round(lerp(60, 8, fill))},${Math.round(lerp(60, 8, fill))},0.35)`);
    g.addColorStop(0.55, 'rgba(255,242,238,0.75)');
    g.addColorStop(0.75, 'rgba(120,0,6,0.25)');
    g.addColorStop(1, 'rgba(255,232,232,0.45)');
    c.fillStyle = g;
    c.fill();

    // foot: two ellipses give it thickness
    const fy = G.y + footY;
    const fk = 0.2;
    c.beginPath();
    c.ellipse(cx, fy, FOOT_R, FOOT_R * fk, 0, 0, Math.PI * 2);
    g = c.createLinearGradient(cx - FOOT_R, 0, cx + FOOT_R, 0);
    g.addColorStop(0, 'rgba(255,236,236,0.2)');
    g.addColorStop(0.5, 'rgba(255,236,236,0.05)');
    g.addColorStop(1, 'rgba(255,236,236,0.22)');
    c.fillStyle = g;
    c.fill();
    c.strokeStyle = 'rgba(255,240,238,0.35)';
    c.lineWidth = 1;
    c.stroke();
    c.beginPath();
    c.ellipse(cx, fy + 0.005 * S, FOOT_R, FOOT_R * fk, 0, 0.05, Math.PI - 0.05);
    c.strokeStyle = 'rgba(255,236,232,0.55)';
    c.lineWidth = 1.2;
    c.stroke();
    // foot highlight
    c.beginPath();
    c.ellipse(cx, fy, FOOT_R * 0.92, FOOT_R * fk * 0.92, 0, Math.PI * 0.62, Math.PI * 0.86);
    c.strokeStyle = 'rgba(255,245,240,0.8)';
    c.lineWidth = 1.6;
    c.stroke();

    // ------------ bowl front
    // thin dark then bright contour: reads as glass thickness
    const contour = (side) => {
      c.beginPath();
      for (let i = 0; i < bowl.length; i++) c.lineTo(cx + side * bowl[i].r, G.y + bowl[i].y);
    };
    g = c.createLinearGradient(0, G.y + rimY, 0, G.y + bowlBottomY);
    g.addColorStop(0, 'rgba(255,236,232,0.75)');
    g.addColorStop(0.45, 'rgba(255,236,232,0.3)');
    g.addColorStop(1, 'rgba(255,236,232,0.6)');
    for (const side of [-1, 1]) {
      contour(side);
      c.strokeStyle = 'rgba(40,2,12,0.35)';
      c.lineWidth = 2.6;
      c.stroke();
      c.strokeStyle = g;
      c.lineWidth = 1.1;
      c.stroke();
    }

    // highlights following the bowl curve
    c.globalCompositeOperation = 'lighter';
    const streak = (side, u0, u1, pos, width, alpha) => {
      const i0 = Math.round(u0 * (bowl.length - 1)), i1 = Math.round(u1 * (bowl.length - 1));
      c.beginPath();
      for (let i = i0; i <= i1; i++) {
        const tpr = Math.sin(((i - i0) / (i1 - i0)) * Math.PI);
        c.lineTo(cx + side * bowl[i].r * (pos - width * tpr), G.y + bowl[i].y);
      }
      for (let i = i1; i >= i0; i--) {
        const tpr = Math.sin(((i - i0) / (i1 - i0)) * Math.PI);
        c.lineTo(cx + side * bowl[i].r * (pos + width * tpr), G.y + bowl[i].y);
      }
      c.closePath();
      const hg = c.createLinearGradient(0, G.y + bowl[i1].y, 0, G.y + bowl[i0].y);
      hg.addColorStop(0, 'rgba(255,244,240,0)');
      hg.addColorStop(0.3, `rgba(255,244,240,${alpha})`);
      hg.addColorStop(0.7, `rgba(255,244,240,${alpha * 0.7})`);
      hg.addColorStop(1, 'rgba(255,244,240,0)');
      c.fillStyle = hg;
      c.fill();
    };
    streak(-1, 0.18, 0.95, 0.78, 0.06, 0.5);
    streak(-1, 0.3, 0.8, 0.6, 0.02, 0.25);
    streak(1, 0.42, 0.86, 0.82, 0.035, 0.28);
    // soft window reflection, upper right
    const wy = G.y + lerp(bowlBottomY, rimY, 0.78);
    g = c.createRadialGradient(cx + R * 0.45, wy, 0, cx + R * 0.45, wy, R * 0.28);
    g.addColorStop(0, 'rgba(255,240,236,0.14)');
    g.addColorStop(1, 'rgba(255,240,236,0)');
    c.fillStyle = g;
    c.fillRect(cx, wy - R * 0.3, R, R * 0.6);
    // crescent at the bottom of the bowl
    c.beginPath();
    c.ellipse(cx, G.y + bowlBottomY - 0.02 * S, R * 0.3, 0.018 * S, 0, 0.15 * Math.PI, 0.85 * Math.PI);
    c.strokeStyle = 'rgba(255,240,236,0.35)';
    c.lineWidth = 1.2;
    c.stroke();
    c.globalCompositeOperation = 'source-over';

    // front of the rim, drawn last so it sits over the wine
    const top = bowl[bowl.length - 1];
    const k = ellK(HB);
    c.beginPath();
    c.ellipse(cx, G.y + top.y, top.r, top.r * k, 0, 0, Math.PI);
    c.strokeStyle = 'rgba(255,238,234,0.7)';
    c.lineWidth = 1.3;
    c.stroke();
    c.beginPath();
    c.ellipse(cx, G.y + top.y + 1.6, top.r - 0.8, top.r * k, 0, 0.1, Math.PI - 0.1);
    c.strokeStyle = 'rgba(40,2,12,0.28)';
    c.lineWidth = 1;
    c.stroke();

    c.restore();
  }

  // 90–100%: a slow band of light travels across the glass and the wine
  function drawShine(c, G, level, p) {
    const s = smooth(0.895, 0.985, p);
    if (s <= 0 || s >= 1) {
      if (p > 0.985) drawGlint(c, G, 0.55 + 0.45 * Math.sin(time * 1.6));
      return;
    }
    const cx = gx + G.x;
    c.save();
    bowlPath(c, G);
    c.clip();
    c.globalCompositeOperation = 'lighter';
    const bx = cx - R * 1.6 + s * R * 3.2;
    const top = G.y + rimY - 10, bot = G.y + bowlBottomY + 10;
    c.translate(bx, (top + bot) / 2);
    c.transform(1, 0, -0.45, 1, 0, 0);
    const w = R * 0.34;
    const g = c.createLinearGradient(-w, 0, w, 0);
    const bell = Math.sin(s * Math.PI);
    g.addColorStop(0, 'rgba(255,238,232,0)');
    g.addColorStop(0.5, `rgba(255,238,232,${0.32 * bell})`);
    g.addColorStop(0.62, `rgba(255,238,232,${0.12 * bell})`);
    g.addColorStop(1, 'rgba(255,238,232,0)');
    c.fillStyle = g;
    c.fillRect(-w, -(bot - top), w * 2, (bot - top) * 2);
    c.restore();
    // glint on the rim as the band passes
    drawGlint(c, G, Math.pow(Math.sin(s * Math.PI), 2) * (s > 0.5 ? 1 : 0.35));
  }

  function drawGlint(c, G, a) {
    if (a <= 0.01) return;
    const top = bowl[bowl.length - 1];
    const x = gx + G.x + top.r * 0.62, y = G.y + top.y + top.r * ellK(HB) * 0.78;
    const size = 0.035 * S * (0.7 + 0.3 * a);
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = a * G.a * 0.9;
    c.drawImage(starSprite, x - size, y - size, size * 2, size * 2);
    c.restore();
  }

  /* ---------------------------------------------------------------
     DOM copy tied to the same progress
  --------------------------------------------------------------- */
  let lastCopy = '';
  function updateCopy(p) {
    const inO = 1 - smooth(0.03, 0.13, p);
    const outO = smooth(0.915, 0.985, p);
    const key = inO.toFixed(3) + outO.toFixed(3);
    if (key === lastCopy) return;
    lastCopy = key;
    if (introEl) {
      introEl.style.opacity = inO;
      introEl.style.transform = `translate3d(0, ${(-24 * (1 - inO)).toFixed(1)}px, 0)`;
    }
    if (hintEl) hintEl.style.opacity = inO;
    if (outroEl) {
      outroEl.style.opacity = outO;
      outroEl.style.transform = `translate3d(0, ${(18 * (1 - outO)).toFixed(1)}px, 0)`;
    }
  }

  /* ---------------------------------------------------------------
     loop
  --------------------------------------------------------------- */
  let running = false;
  let frameMs = 0;
  let rafId = 0;

  function frame(nowMs) {
    rafId = requestAnimationFrame(frame);
    const now = nowMs / 1000;
    const dt = lastNow ? clamp(now - lastNow, 1 / 240, 1 / 24) : 1 / 60;
    lastNow = now;
    time += dt;

    const t0 = performance.now();
    const p = clamp(readProgress(dt));
    update(dt, p);
    render(dt, p);
    updateCopy(p);
    frameMs = lerp(frameMs, performance.now() - t0, 0.1);
  }

  function start() {
    if (running) return;
    running = true;
    lastNow = 0;
    rafId = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
  }

  /* ---------------------------------------------------------------
     progress source: GSAP ScrollTrigger (pin + scrub), with a sticky
     fallback if the library could not load
  --------------------------------------------------------------- */
  const PIN_SCREENS = 3.5;
  let readProgress;

  if (window.gsap && window.ScrollTrigger) {
    gsap.registerPlugin(ScrollTrigger);
    ScrollTrigger.config({ ignoreMobileResize: true });
    gsap.to(driver, {
      p: 1,
      ease: 'none',
      scrollTrigger: {
        trigger: section,
        start: 'top top',
        end: () => '+=' + Math.round(window.innerHeight * PIN_SCREENS),
        pin: true,
        scrub: 1,
        anticipatePin: 1,
        invalidateOnRefresh: true,
      },
    });
    readProgress = () => driver.p;
  } else {
    section.style.height = `${(PIN_SCREENS + 1) * 100}vh`;
    section.style.overflow = 'visible';
    stage.style.position = 'sticky';
    stage.style.top = '0';
    stage.style.height = '100vh';
    readProgress = (dt) => {
      const r = section.getBoundingClientRect();
      const target = clamp(-r.top / Math.max(1, r.height - window.innerHeight));
      driver.p = lerp(driver.p, target, 1 - Math.exp(-dt / 0.25));
      return driver.p;
    };
  }

  /* ---------------------------------------------------------------
     wiring
  --------------------------------------------------------------- */
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.ty = (e.clientY / window.innerHeight) * 2 - 1;
  }, { passive: true });

  let resizeTimer = 0;
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layout, 60);
  });
  ro.observe(stage);

  new IntersectionObserver((entries) => {
    for (const e of entries) (e.isIntersecting ? start : stop)();
  }, { rootMargin: '100px 0px' }).observe(section);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (section.getBoundingClientRect().bottom > 0 && section.getBoundingClientRect().top < window.innerHeight) start();
  });

  layout();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => window.ScrollTrigger && ScrollTrigger.refresh());

  // exposed for debugging and automated checks
  window.__brosePour = { get progress() { return driver.p; }, get frameMs() { return frameMs; } };
})();
