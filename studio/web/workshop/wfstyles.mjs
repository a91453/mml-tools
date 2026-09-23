// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Waterfall note styles and hit effects.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
export function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export const mixWhite = (c, k) => [
  c[0] + (255 - c[0]) * k,
  c[1] + (255 - c[1]) * k,
  c[2] + (255 - c[2]) * k,
];

export const mixBlack = (c, k) => [c[0] * (1 - k), c[1] * (1 - k), c[2] * (1 - k)];

export function capsule(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const SLOW = 2.4;
const FAST = 1.2;

const SPREAD = 1;

const phase = (b, period) => (b.t / period + rng(b.seed)() * SPREAD) % 1;

function stepAt(table, p) {
  let v = table[table.length - 1][1];
  for (const [at, x] of table) {
    if (p < at) break;
    v = x;
  }
  return v;
}

export function keyPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.closePath();
}

export function chamfer(ctx, x, y, w, h, c) {
  const k = Math.min(c, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.lineTo(x + w - k, y);
  ctx.lineTo(x + w, y + k);
  ctx.lineTo(x + w, y + h - k);
  ctx.lineTo(x + w - k, y + h);
  ctx.lineTo(x + k, y + h);
  ctx.lineTo(x, y + h - k);
  ctx.lineTo(x, y + k);
  ctx.closePath();
}

const PIXEL_GRID = 3;

const PIXEL_BANDS = 4;

const ELECTRIC_STEPS = [
  [0.00, 0.55], [0.08, 1.00], [0.12, 0.30],
  [0.30, 0.80], [0.34, 0.45],
  [0.62, 1.00], [0.66, 0.50],
];

const ELECTRIC_IDLE = [
  [0.000, 0.42],
  [0.550, 1.00], [0.575, 0.45],
  [0.600, 0.90], [0.615, 0.40],
  [0.640, 0.75], [0.660, 0.42],
];

const NEON_FLARE = 9;

const GLOW_HALOS = [[64, 0.55], [30, 0.75], [13, 0.95]];

const GLOW_IDLE = 0.67;
const GLOW_FLARE = 9;

const FLOW_LOBES = 2;

const FLOW_NOTCH = [[0.90, 0.20], [0.66, 0.32], [0.40, 0.45], [0.17, 0.90]];

const FLOW_NOTCH_AT = 0.53;

const BOUNCE_HZ = 4.5;
const BOUNCE_DECAY = 5;
const BOUNCE_W = 0.45;

const FROST_CUT = 4;

const FROST_MIST = 3;

const FROST_FALL = 1.1;

const FROST_DROP = 46;

const FROST_BITE = 30;

const FROST_SPEED = 620;

const FROST_EDGE = 40;

const FROST_SPIKE = 5;

const FROST_SPIKE_LEN = 60;

const GLITCH_STEPS = [
  [0.00, null],
  [0.85, { dx:  1, r: [-9, -1, 0.22, 0.32], c: [ 4,  1, 0.55, 0.62] }],
  [0.88, null],
  [0.91, { dx: -1, r: [ 5,  1, 0.62, 0.70], c: [-7,  0, 0.30, 0.38] }],
  [0.94, null],
  [0.97, { dx:  0, r: [-6, -1, 0.44, 0.51], c: [ 3, -1, 0.12, 0.19] }],
];

const GLITCH_SHARE = 1 / 3;

const TOON = {
  ink: "#14141c",
  bed: "#241f3d",
  white: "#f7f2e0",
  black: "#332f4e",
  blackTop: "#4a4668",
  line: "#e8556d",
};
const TOON_FOOT = 9;
const TOON_GLINT = 26;

export const NOTE_STYLES = [
  {
    id: "glass",
    composite: "lighter",
    draw(ctx, b) {
      const { x, w, y, h, r, top, bottom, fullH, color: c, active, u, kbTop, cx, kw } = b;
      const tip = mixWhite(c, active ? 0.85 : 0.65);
      const lite = mixWhite(c, 0.45);

      ctx.shadowColor = rgba(c, active ? 0.85 : 0.45);
      ctx.shadowBlur = (active ? 26 : 14) * u;

      const grad = ctx.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0.00, rgba(c, active ? 0.10 : 0.05));
      grad.addColorStop(0.35, rgba(c, active ? 0.42 : 0.28));
      grad.addColorStop(0.80, rgba(lite, active ? 0.72 : 0.52));
      grad.addColorStop(1.00, rgba(tip, active ? 0.95 : 0.80));
      ctx.fillStyle = grad;
      capsule(ctx, x, y, w, h, r);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.save();
      capsule(ctx, x, y, w, h, r);
      ctx.clip();

      const coreW = Math.max(2 * u, w * 0.40);
      const coreGrad = ctx.createLinearGradient(0, top, 0, bottom);
      coreGrad.addColorStop(0.00, "rgba(255,255,255,0)");
      coreGrad.addColorStop(0.55, rgba(lite, active ? 0.30 : 0.14));
      coreGrad.addColorStop(1.00, `rgba(255,255,255,${active ? 0.60 : 0.32})`);
      ctx.fillStyle = coreGrad;
      capsule(ctx, x + (w - coreW) / 2, y + 2 * u, coreW,
        Math.max(0, h - 4 * u), coreW / 2);
      ctx.fill();

      const sheen = ctx.createLinearGradient(x, 0, x + w, 0);
      sheen.addColorStop(0.06, `rgba(255,255,255,${active ? 0.30 : 0.17})`);
      sheen.addColorStop(0.32, "rgba(255,255,255,0)");
      sheen.addColorStop(0.86, "rgba(255,255,255,0)");
      sheen.addColorStop(1.00, `rgba(255,255,255,${active ? 0.10 : 0.05})`);
      ctx.fillStyle = sheen;
      ctx.fillRect(x, y, w, h);

      const tipR = Math.max(w * 1.6, 18 * u);
      const tg = ctx.createRadialGradient(x + w / 2, bottom, u, x + w / 2, bottom, tipR);
      tg.addColorStop(0, `rgba(255,255,255,${active ? 0.85 : 0.45})`);
      tg.addColorStop(0.45, rgba(tip, active ? 0.35 : 0.18));
      tg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = tg;
      ctx.fillRect(x, bottom - tipR, w, tipR);

      ctx.globalCompositeOperation = "source-over";
      const capH = Math.min(14 * u, fullH * 0.3);
      const cap = ctx.createLinearGradient(0, top, 0, top + capH);
      cap.addColorStop(0, "rgba(10,16,34,0.30)");
      cap.addColorStop(1, "rgba(10,16,34,0)");
      ctx.fillStyle = cap;
      ctx.fillRect(x, y, w, capH);
      ctx.globalCompositeOperation = "lighter";

      ctx.restore();

      ctx.strokeStyle = rgba(lite, active ? 0.55 : 0.26);
      ctx.lineWidth = u;
      capsule(ctx, x + u / 2, y + u / 2, w - u, Math.max(0, h - u), r);
      ctx.stroke();

      if (active) {
        const rad = kw * 2.4;
        const rg = ctx.createRadialGradient(cx, kbTop, 2 * u, cx, kbTop, rad);
        rg.addColorStop(0, rgba(c, 0.5));
        rg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(cx - rad, kbTop - rad, rad * 2, rad);
      }
    },
  },

  {
    id: "neon",
    composite: "lighter",
    draw(ctx, b) {
      const { x, w, y, h, r, top, bottom, color: c, active, u, kbTop, cx, kw } = b;
      const lite = mixWhite(c, 0.55);
      const flare = active ? Math.exp(-b.age * NEON_FLARE) : 0;

      if (active) {
        const pad = 3 * u;
        ctx.shadowColor = rgba(lite, 0.85);
        ctx.shadowBlur = (24 + flare * 26) * u;
        ctx.fillStyle = rgba(c, 0.1 + flare * 0.14);
        capsule(ctx, x - pad, y - pad, w + pad * 2, h + pad * 2, r + pad);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      const grad = ctx.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0, rgba(c, active ? 0.34 + flare * 0.28 : 0.08));
      grad.addColorStop(1, rgba(c, active ? 0.62 + flare * 0.28 : 0.20));
      ctx.fillStyle = grad;
      capsule(ctx, x, y, w, h, r);
      ctx.fill();

      const lw = (active ? 2.6 : 2.0) * u;
      ctx.shadowColor = rgba(lite, active ? 1 : 0.95);
      ctx.shadowBlur = (active ? 24 + flare * 14 : 18) * u;
      ctx.strokeStyle = rgba(active ? mixWhite(c, 0.9) : mixWhite(c, 0.7), active ? 0.95 : 0.88);
      ctx.lineWidth = lw;
      capsule(ctx, x + lw / 2, y + lw / 2, w - lw, Math.max(0, h - lw), r);
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.save();
      capsule(ctx, x, y, w, h, r);
      ctx.clip();
      const headH = 16 * u;
      const cg = ctx.createLinearGradient(0, bottom - headH, 0, bottom);
      cg.addColorStop(0, rgba(lite, 0));
      cg.addColorStop(1, `rgba(255,255,255,${active ? 0.9 : 0.62})`);
      ctx.fillStyle = cg;
      ctx.fillRect(x, bottom - headH, w, headH);
      ctx.restore();

      if (active) {
        const rad = kw * 1.9 * (1 + flare * 0.35);
        const rg = ctx.createRadialGradient(cx, kbTop, 2 * u, cx, kbTop, rad);
        rg.addColorStop(0, rgba(lite, 0.55 + flare * 0.3));
        rg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(cx - rad, kbTop - rad, rad * 2, rad);
      }
    },
  },

  {
    id: "pixel",
    composite: "source-over",
    draw(ctx, b) {
      const { x, w, y, h, color: c, active, u, kbTop, cx, kw } = b;
      const g = PIXEL_GRID * u;
      const y0 = Math.round(y / g) * g;
      const hh = Math.max(g, Math.round((y + h) / g) * g - y0);

      for (let i = 0; i < PIXEL_BANDS; i++) {
        const b0 = y0 + Math.round((hh * i / PIXEL_BANDS) / g) * g;
        const b1 = y0 + Math.round((hh * (i + 1) / PIXEL_BANDS) / g) * g;
        if (b1 <= b0) continue;
        const k = i / (PIXEL_BANDS - 1);
        ctx.fillStyle = rgba(mixWhite(c, (active ? 0.22 : 0.04) + k * 0.48),
          active ? 1 : 0.9);
        ctx.fillRect(x, b0, w, b1 - b0);
      }

      ctx.fillStyle = "rgba(8,12,28,0.55)";
      ctx.fillRect(x, y0, w, g);
      ctx.fillStyle = `rgba(255,255,255,${active ? 0.95 : 0.62})`;
      ctx.fillRect(x, y0 + hh - g, w, g);

      if (active) {
        ctx.fillStyle = rgba(mixWhite(c, 0.45), 0.5);
        ctx.fillRect(cx - kw, kbTop - g * 2, kw * 2, g * 2);
      }
    },
  },

  {
    id: "saber",
    composite: "lighter",
    draw(ctx, b) {
      const { x, w, y, h, r, top, bottom, fullH, color: c, active, u, kbTop, cx, kw } = b;

      ctx.shadowColor = rgba(c, active ? 0.95 : 0.6);
      ctx.shadowBlur = (active ? 24 : 13) * u;
      ctx.fillStyle = rgba(c, active ? 0.88 : 0.62);
      capsule(ctx, x, y, w, h, r);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.save();
      capsule(ctx, x, y, w, h, r);
      ctx.clip();
      const coreW = Math.max(1.5 * u, w * 0.44);
      const inset = Math.min(4 * u, fullH / 3);
      const cg = ctx.createLinearGradient(0, top, 0, bottom);
      cg.addColorStop(0, `rgba(255,255,255,${active ? 0.88 : 0.6})`);
      cg.addColorStop(1, `rgba(255,255,255,${active ? 1 : 0.82})`);
      ctx.fillStyle = cg;
      capsule(ctx, x + (w - coreW) / 2, top + inset, coreW,
        Math.max(0, fullH - inset * 2), coreW / 2);
      ctx.fill();
      ctx.restore();

      if (active) {
        const rad = kw * 2.1;
        const rg = ctx.createRadialGradient(cx, kbTop, 2 * u, cx, kbTop, rad);
        rg.addColorStop(0, "rgba(255,255,255,0.6)");
        rg.addColorStop(0.4, rgba(c, 0.4));
        rg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(cx - rad, kbTop - rad, rad * 2, rad);
      }
    },
  },

  {
    id: "flowborder",
    composite: "source-over",
    draw(ctx, b) {
      const { x, w, y, h, r, top, fullH, color: c, active, u, kbTop, cx, kw } = b;
      const lw = Math.min((active ? 2.8 : 2.1) * u, w / 3);

      ctx.fillStyle = rgba(mixWhite(c, 0.45), active ? 1 : 0.82);
      capsule(ctx, x, y, w, h, r);
      ctx.fill();

      ctx.fillStyle = `rgba(16,24,42,${active ? 0.88 : 0.94})`;
      capsule(ctx, x + lw, top + lw, Math.max(0, w - lw * 2),
        Math.max(0, fullH - lw * 2), Math.max(0, r - lw));
      ctx.fill();

      const bw = Math.max(0, w - lw);
      const bh = Math.max(0, fullH - lw);
      const rr = Math.min(Math.max(0, r - lw / 2), bw / 2, bh / 2);
      const per = 2 * (bw - 2 * rr) + 2 * (bh - 2 * rr) + 2 * Math.PI * rr;
      if (per > 0) {
        const seg = per / FLOW_LOBES;
        ctx.lineWidth = lw;
        for (const [frac, a] of FLOW_NOTCH) {
          const cut = seg * frac;
          const pre = Math.max(0, Math.min(seg - cut, seg * FLOW_NOTCH_AT - cut / 2));
          ctx.setLineDash([0, pre, cut, seg - pre - cut]);
          ctx.lineDashOffset = -phase(b, SLOW) * per;
          ctx.strokeStyle = `rgba(16,24,42,${a})`;
          capsule(ctx, x + lw / 2, top + lw / 2, bw, bh, rr);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      }

      if (active) {
        const rad = kw * 1.8;
        const rg = ctx.createRadialGradient(cx, kbTop, 2 * u, cx, kbTop, rad);
        rg.addColorStop(0, rgba(mixWhite(c, 0.7), 0.5));
        rg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(cx - rad, kbTop - rad, rad * 2, rad);
      }
    },
  },

  {
    id: "glow",
    composite: "source-over",
    draw(ctx, b) {
      const { x, w, y, h, r, bottom, color: c, active, u, kbTop, cx, kw } = b;
      const pw = active ? 1 : GLOW_IDLE;
      const flare = active ? Math.exp(-b.age * GLOW_FLARE) : 0;
      const rr = Math.min(r, 6 * u);
      const core = mixBlack(mixWhite(c, 0.30 * pw), 0.30 * (1 - pw));

      ctx.globalCompositeOperation = "lighter";
      for (const [blur, alpha] of GLOW_HALOS) {
        ctx.shadowColor = rgba(mixWhite(c, 0.15), alpha * pw);
        ctx.shadowBlur = blur * u * (0.4 + pw * 0.6);
        ctx.fillStyle = rgba(c, 1);
        capsule(ctx, x, y, w, h, rr);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = "source-over";

      ctx.fillStyle = rgba(core, 1);
      capsule(ctx, x, y, w, h, rr);
      ctx.fill();

      const lw = Math.max(u, Math.min(1.6 * u, w * 0.12));
      ctx.strokeStyle = rgba(mixWhite(c, 0.55), 0.12 + 0.68 * pw);
      ctx.lineWidth = lw;
      capsule(ctx, x + lw / 2, y + lw / 2, Math.max(0, w - lw), Math.max(0, h - lw), rr);
      ctx.stroke();

      ctx.save();
      capsule(ctx, x, y, w, h, rr);
      ctx.clip();
      const headH = 14 * u;
      const hg = ctx.createLinearGradient(0, bottom - headH, 0, bottom);
      hg.addColorStop(0, "rgba(255,255,255,0)");
      hg.addColorStop(1, `rgba(255,255,255,${0.55 * pw})`);
      ctx.fillStyle = hg;
      ctx.fillRect(x, bottom - headH, w, headH);
      ctx.restore();

      if (active) {
        ctx.globalCompositeOperation = "lighter";
        const rad = kw * 1.9 * (1 + flare * 0.35);
        const rg = ctx.createRadialGradient(cx, kbTop, 2 * u, cx, kbTop, rad);
        rg.addColorStop(0, rgba(mixWhite(c, 0.55), 0.55 + flare * 0.3));
        rg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(cx - rad, kbTop - rad, rad * 2, rad);
        ctx.globalCompositeOperation = "source-over";
      }
    },
  },

  {
    id: "electric",
    composite: "lighter",
    draw(ctx, b) {
      const { x, w, y, h, top, bottom, color: c, active, u, kbTop, cx, kw } = b;
      const k = active
        ? stepAt(ELECTRIC_STEPS, phase(b, FAST))
        : stepAt(ELECTRIC_IDLE, phase(b, SLOW));
      const lite = mixWhite(c, 0.8);

      const g = ctx.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0.0, rgba(mixWhite(c, 0.88), active ? 0.95 : 0.66));
      g.addColorStop(0.3, rgba(lite, active ? 0.85 : 0.55));
      g.addColorStop(1.0, rgba(mixBlack(c, 0.25), active ? 0.8 : 0.5));
      ctx.fillStyle = g;
      ctx.shadowColor = rgba(lite, Math.min(1, (active ? 0.9 : 0.62) * k));
      ctx.shadowBlur = (active ? 26 : 14) * k * u;
      ctx.fillRect(x, y, w, h);
      ctx.shadowBlur = 0;

      if (active && k > 0.9) {
        const coreW = Math.max(u, w * 0.3);
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.fillRect(x + (w - coreW) / 2, y, coreW, h);
      }

      if (active) {
        const rad = kw * 2.2 * (0.7 + k * 0.3);
        const rg = ctx.createRadialGradient(cx, kbTop, 2 * u, cx, kbTop, rad);
        rg.addColorStop(0, rgba(mixWhite(c, 0.9), 0.55 * k));
        rg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(cx - rad, kbTop - rad, rad * 2, rad);
      }
    },
  },

  {
    id: "frost",
    composite: "source-over",
    draw(ctx, b) {
      const { x, w, y, h, top, bottom, fullH, color: c, active, u, kbTop, cx } = b;
      const cut = Math.min(w * 0.18, FROST_CUT * u);
      const breath = active ? 0.5 + 0.5 * Math.sin(2 * Math.PI * phase(b, SLOW)) : 0;
      const ice = active ? 0.30 + breath * 0.2 : 0;
      const body = mixWhite(c, 0.3 + ice * 0.5);
      const pale = mixWhite(c, 0.72);

      const g = ctx.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, rgba(mixWhite(body, 0.25), active ? 0.92 : 0.58));
      g.addColorStop(1, rgba(body, active ? 0.78 : 0.4));
      ctx.fillStyle = g;
      ctx.shadowColor = rgba(pale, active ? 0.35 + breath * 0.4 : 0);
      ctx.shadowBlur = active ? (10 + breath * 16) * u : 0;
      chamfer(ctx, x, y, w, h, cut);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.save();
      chamfer(ctx, x, y, w, h, cut);
      ctx.clip();

      const lwx = Math.max(u, w * 0.09);
      ctx.strokeStyle = `rgba(255,255,255,${0.18 + ice * 0.55})`;
      ctx.lineWidth = lwx;
      for (const [at, dir] of [[0.34, 1], [0.68, -1]]) {
        const my = top + fullH * at;
        ctx.beginPath();
        ctx.moveTo(x, my - fullH * 0.06 * dir);
        ctx.lineTo(x + w, my + fullH * 0.06 * dir);
        ctx.stroke();
      }

      ctx.strokeStyle = `rgba(255,255,255,${0.16 + ice * 0.45})`;
      ctx.lineWidth = 2 * u;
      chamfer(ctx, x + u, y + u, Math.max(0, w - 2 * u), Math.max(0, h - 2 * u), cut);
      ctx.stroke();

      if (active) {
        const reach = Math.min(fullH, (FROST_BITE + FROST_SPEED * b.age) * u);
        const fy = kbTop - reach;
        const a = 0.42 + breath * 0.18;
        const fg = ctx.createLinearGradient(0, fy, 0, kbTop);
        fg.addColorStop(0, "rgba(240,250,255,0)");
        fg.addColorStop(Math.min(FROST_EDGE * u, reach * 0.8) / reach, `rgba(240,250,255,${a})`);
        fg.addColorStop(1, `rgba(240,250,255,${a})`);
        ctx.fillStyle = fg;
        ctx.fillRect(x, fy, w, reach);

        const spike = Math.min(reach, FROST_SPIKE_LEN * u);
        const rs = rng(b.seed ^ 0x5f);
        ctx.strokeStyle = `rgba(255,255,255,${0.45 + breath * 0.3})`;
        ctx.lineWidth = Math.max(u, w * 0.07);
        for (let i = 0; i < FROST_SPIKE; i++) {
          const sx = x + w * (0.12 + 0.76 * rs());
          const len = spike * (0.3 + 0.6 * rs());
          const lean = (rs() - 0.5) * w * 0.3;
          ctx.beginPath();
          ctx.moveTo(sx, kbTop);
          ctx.lineTo(sx + lean, kbTop - len);
          ctx.stroke();
        }
      }
      ctx.restore();

      ctx.strokeStyle = `rgba(255,255,255,${active ? 0.85 : 0.4})`;
      ctx.lineWidth = u;
      chamfer(ctx, x + u / 2, y + u / 2, Math.max(0, w - u), Math.max(0, h - u), cut);
      ctx.stroke();

      if (active) {
        const rand = rng(b.seed);
        for (let i = 0; i < FROST_MIST; i++) {
          const k = (b.age / FROST_FALL + i / FROST_MIST + rand() * 0.4) % 1;
          const a = Math.sin(Math.PI * k) * 0.42;
          const sway = (rand() - 0.5) * w * 1.6 * k;
          if (a < 0.02) continue;
          const px = cx + sway;
          const py = kbTop - FROST_DROP * u * (1 - k);
          const rad = w * (0.55 + k * 0.9);
          const mg = ctx.createRadialGradient(px, py, 0, px, py, rad);
          mg.addColorStop(0, `rgba(236,248,255,${a})`);
          mg.addColorStop(1, "rgba(236,248,255,0)");
          ctx.save();
          ctx.translate(px, py);
          ctx.scale(1, 0.55);
          ctx.fillStyle = mg;
          ctx.translate(-px, -py);
          ctx.fillRect(px - rad, py - rad, rad * 2, rad * 2);
          ctx.restore();
        }
      }
    },
  },

  {
    id: "glitch",
    composite: "source-over",
    draw(ctx, b) {
      const { x, w, y, h, top, fullH, color: c, active, u, kbTop, cx, kw } = b;
      const glitchy = rng(b.seed * 4271 + 9)() < GLITCH_SHARE;
      const gl = glitchy ? stepAt(GLITCH_STEPS, phase(b, FAST)) : null;
      const dx = gl ? gl.dx * u : 0;
      const rr = Math.min(3 * u, w * 0.2);

      ctx.fillStyle = rgba(mixWhite(c, active ? 0.82 : 0.66), active ? 0.95 : 0.8);
      capsule(ctx, x + dx, y, w, h, rr);
      ctx.fill();

      if (gl) {
        for (const [col, o] of [["255,45,85", gl.r], ["0,229,255", gl.c]]) {
          const y0 = top + fullH * o[2];
          const y1 = top + fullH * o[3];
          ctx.fillStyle = `rgba(${col},${active ? 0.75 : 0.6})`;
          ctx.fillRect(x + dx + o[0] * u, y0 + o[1] * u, w, y1 - y0);
        }
      }

      if (active) {
        const rad = kw * 1.9;
        const rg = ctx.createRadialGradient(cx, kbTop, 2 * u, cx, kbTop, rad);
        rg.addColorStop(0, rgba(mixWhite(c, 0.8), 0.45));
        rg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(cx - rad, kbTop - rad, rad * 2, rad);
      }
    },
  },

  {
    id: "bubble",
    composite: "source-over",
    draw(ctx, b) {
      const { x, w, y, h, r, top, bottom, color: c, active, u, kbTop, cx, kw } = b;
      const bounce = active
        ? Math.exp(-b.age * BOUNCE_DECAY) * Math.cos(2 * Math.PI * BOUNCE_HZ * b.age)
        : 0;
      const wob = Math.max(0.35,
        1 + 0.02 * Math.sin(2 * Math.PI * phase(b, SLOW)) + BOUNCE_W * bounce);
      const ww = w * wob;
      const xx = x + (w - ww) / 2;
      const rr = Math.min(r, ww / 2);
      const mid = (top + bottom) / 2;

      const g = ctx.createRadialGradient(xx + ww / 2, mid, 0,
        xx + ww / 2, mid, Math.max(ww, bottom - top) * 0.62);
      g.addColorStop(0.00, "rgba(255,255,255,0.02)");
      g.addColorStop(0.55, rgba(c, active ? 0.2 : 0.1));
      g.addColorStop(0.86, rgba(mixWhite(c, 0.35), active ? 0.62 : 0.42));
      g.addColorStop(1.00, `rgba(255,255,255,${active ? 0.8 : 0.6})`);
      ctx.fillStyle = g;
      capsule(ctx, xx, y, ww, h, rr);
      ctx.fill();

      ctx.strokeStyle = `rgba(255,255,255,${active ? 0.72 : 0.5})`;
      ctx.lineWidth = u;
      capsule(ctx, xx + u / 2, y + u / 2, Math.max(0, ww - u), Math.max(0, h - u), rr);
      ctx.stroke();

      ctx.save();
      capsule(ctx, xx, y, ww, h, rr);
      ctx.clip();
      const hr = Math.max(2 * u, ww * 0.3);
      const hy = top + Math.min((bottom - top) * 0.2, ww * 1.2);
      const hg = ctx.createRadialGradient(xx + ww * 0.32, hy, 0, xx + ww * 0.32, hy, hr);
      hg.addColorStop(0, `rgba(255,255,255,${active ? 0.85 : 0.62})`);
      hg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = hg;
      ctx.fillRect(xx, hy - hr, ww, hr * 2);
      ctx.restore();

      if (active) {
        const rad = kw * 1.8;
        const rg = ctx.createRadialGradient(cx, kbTop, 2 * u, cx, kbTop, rad);
        rg.addColorStop(0, rgba(mixWhite(c, 0.6), 0.4));
        rg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(cx - rad, kbTop - rad, rad * 2, rad);
      }
    },
  },

  {
    id: "toon",
    composite: "source-over",
    draw(ctx, b) {
      const { x, w, y, h, r, top, bottom, color: c, active, u, kbTop, cx, kw } = b;
      const rr = Math.min(r, w * 0.22);
      const line = Math.max(u, 2 * u);

      ctx.fillStyle = rgba(mixWhite(c, active ? 0.25 : 0), 1);
      capsule(ctx, x, y, w, h, rr);
      ctx.fill();

      ctx.save();
      capsule(ctx, x, y, w, h, rr);
      ctx.clip();
      const foot = Math.min(TOON_FOOT * u, h * 0.35);
      ctx.fillStyle = rgba(mixBlack(c, 0.22), 1);
      ctx.fillRect(x, bottom - foot, w, foot);
      ctx.restore();

      ctx.strokeStyle = TOON.ink;
      ctx.lineWidth = line;
      capsule(ctx, x, y, w, h, rr);
      ctx.stroke();

      const gw = Math.max(u, w * 0.22);
      const gx = x + w * 0.26;
      const gy = top + line + gw;
      const glint = Math.min(TOON_GLINT * u, h * 0.45, Math.max(0, h - line * 2 - gw * 2));
      if (glint > 0) {
        ctx.save();
        capsule(ctx, x, y, w, h, rr);
        ctx.clip();
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineCap = "round";
        ctx.lineWidth = gw;
        ctx.beginPath();
        ctx.moveTo(gx, gy + gw / 2);
        ctx.lineTo(gx, gy + glint);
        ctx.stroke();
        ctx.lineCap = "butt";
        ctx.restore();
      }

      if (active) {
        ctx.fillStyle = rgba(mixWhite(c, 0.5), 0.55);
        ctx.fillRect(cx - kw, kbTop - 4 * u, kw * 2, 4 * u);
        ctx.fillStyle = TOON.ink;
        ctx.fillRect(cx - kw, kbTop - 5 * u, kw * 2, u);
      }
    },

    keyboard(ctx, kb) {
      const { keys, act, kbTop, kbH, blackH, W, u } = kb;
      const line = Math.max(u, 2 * u);
      const press = 2.5 * u;

      ctx.fillStyle = TOON.bed;
      ctx.fillRect(0, kbTop, W, kbH);
      ctx.fillStyle = TOON.line;
      ctx.fillRect(0, kbTop - 2.5 * u, W, 2.5 * u);

      for (const k of keys) {
        if (k.black) continue;
        const c = act.get(k.midi);
        const p = c ? press : 0;
        const gap = line;
        const x = k.x + gap / 2 + p;
        const w = k.w - gap - p * 2;
        if (w <= 0) continue;

        ctx.fillStyle = c ? rgba(mixWhite(c, 0.35), 1) : TOON.white;
        keyPath(ctx, x, kbTop, w, kbH - gap / 2 - p, k.w * 0.22);
        ctx.fill();
        ctx.strokeStyle = TOON.ink;
        ctx.lineWidth = line;
        ctx.stroke();
      }

      for (const k of keys) {
        if (!k.black) continue;
        const c = act.get(k.midi);
        const p = c ? press : 0;
        const x = k.x + p;
        const w = k.w - p * 2;
        const h = blackH - p;
        if (w <= 0 || h <= 0) continue;

        ctx.fillStyle = c ? rgba(mixWhite(c, 0.2), 1) : TOON.black;
        keyPath(ctx, x, kbTop, w, h, k.w * 0.3);
        ctx.fill();
        ctx.strokeStyle = TOON.ink;
        ctx.lineWidth = line;
        ctx.stroke();

        if (!c) {
          const hw = w * 0.42;
          const hh = h * 0.5;
          ctx.fillStyle = TOON.blackTop;
          keyPath(ctx, x + (w - hw) / 2, kbTop + line * 1.5, hw, hh, hw / 2);
          ctx.fill();
        }
      }
    },
  },

  {
    id: "retro",
    composite: "source-over",
    draw(ctx, b) {
      const { x, w, y, h, color: c, active, u, kbTop, cx, kw } = b;
      const ink = "#08080f";
      const line = Math.max(u, Math.min(4 * u, w * 0.18, h * 0.25));
      const body = mixWhite(c, active ? 0.28 : 0);

      ctx.fillStyle = ink;
      ctx.fillRect(x, y, w, h);

      const ix = x + line, iy = y + line;
      const iw = w - line * 2, ih = h - line * 2;
      if (iw <= 0 || ih <= 0) return;

      ctx.fillStyle = rgba(body, 1);
      ctx.fillRect(ix, iy, iw, ih);

      const bw = Math.min(4 * u, iw * 0.3), bh = Math.min(4 * u, ih * 0.3);
      ctx.fillStyle = rgba(mixWhite(body, 0.45), 1);
      ctx.fillRect(ix, iy, iw, bh);
      ctx.fillRect(ix, iy, bw, ih);
      ctx.fillStyle = rgba(mixBlack(body, 0.45), 1);
      ctx.fillRect(ix, iy + ih - bh, iw, bh);
      ctx.fillRect(ix + iw - bw, iy, bw, ih);

      if (active) {
        ctx.fillStyle = rgba(mixWhite(c, 0.5), 1);
        ctx.fillRect(cx - kw, kbTop - 5 * u, kw * 2, 4 * u);
        ctx.fillStyle = ink;
        ctx.fillRect(cx - kw, kbTop - u, kw * 2, u);
      }
    },
  },
];

const BURST_G = 220;

const NOVA_SPIKES = [-Math.PI / 2, -0.18, -Math.PI + 0.18, -1.15, -2.05, -Math.PI / 2 + 0.02];

const NOVA_SCALE = 0.5625;

const SMOKE_MORE = 1.25;

const EMBER_EASE = 0.72;
const EMBER_FLICKER = 5.5;
const SPLASH_G = 1400;
const SPLASH_JET = 0.42;
const SPLASH_CROWN = 0.2;

export const HIT_FX = [
  {
    id: "burst",
    composite: "lighter",
    span: 0.75,
    draw(ctx, hit) {
      const { x: x0, y: y0, age, vel, color: c, u, seed } = hit;
      const r = rng(seed * 977 + 1);
      const cnt = 8 + Math.floor(vel * 10);
      for (let i = 0; i < cnt; i++) {
        const ang = -Math.PI / 2 + (r() - 0.5) * 1.6;
        const sp = (60 + r() * 160 * vel) * u;
        const rad = (1 + r() * 2.2) * u;
        const life = 1 - age / (0.4 + r() * (0.75 - 0.4));
        if (life <= 0) continue;
        const px = x0 + Math.cos(ang) * sp * age;
        const py = y0 + Math.sin(ang) * sp * age + 0.5 * BURST_G * u * age * age;
        ctx.fillStyle = rgba(c, 0.7 * life);
        ctx.shadowColor = rgba(c, life);
        ctx.shadowBlur = 8 * u;
        ctx.beginPath();
        ctx.arc(px, py, rad * life + 0.4 * u, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },

  {
    id: "ripple",
    composite: "lighter",
    span: 1.8,
    draw(ctx, hit) {
      const { x, y, w, age, vel, color: c, u } = hit;
      const lite = mixWhite(c, 0.5);
      for (let i = 0; i < 3; i++) {
        const born = i * 0.22;
        const k = (age - born) / (1.8 - born);
        if (k <= 0 || k >= 1) continue;
        const rad = w * (0.3 + 3.9 * k) * (0.75 + vel * 0.5);
        const spread = 1 / (1 + rad / (w * 2.2));
        const fade = (1 - k) * spread;
        ctx.strokeStyle = rgba(i === 0 ? lite : c, fade * (0.5 + vel * 0.55));
        ctx.lineWidth = (2.2 * fade + 0.35) * u;
        ctx.beginPath();
        ctx.arc(x, y, rad, Math.PI, Math.PI * 2);
        ctx.stroke();
      }
    },
  },

  {
    id: "beam",
    composite: "lighter",
    span: 0.5,
    draw(ctx, hit) {
      const { x, y, w, age, vel, color: c, u } = hit;
      const k = age / 0.5;
      const fade = (1 - k) * (1 - k);
      const lite = mixWhite(c, 0.55);

      const hgt = (90 + 340 * vel) * u;
      const bw = w * (0.55 + 0.75 * fade);
      const g = ctx.createLinearGradient(0, y - hgt, 0, y);
      g.addColorStop(0, rgba(lite, 0));
      g.addColorStop(1, rgba(lite, fade * (0.3 + vel * 0.45)));
      ctx.fillStyle = g;
      ctx.fillRect(x - bw / 2, y - hgt, bw, hgt);

      const rad = w * (1.2 + 1.8 * k);
      const rg = ctx.createRadialGradient(x, y, u, x, y, rad);
      rg.addColorStop(0, `rgba(255,255,255,${fade * 0.75})`);
      rg.addColorStop(0.4, rgba(lite, fade * 0.4));
      rg.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = rg;
      ctx.fillRect(x - rad, y - rad, rad * 2, rad);
    },
  },

  {
    id: "smoke",
    composite: "source-over",
    span: 1.2,
    draw(ctx, hit) {
      const { x, y, w, age, vel, color: c, u, seed } = hit;
      const r = rng(seed * 5051 + 7);
      const cnt = Math.round((4 + vel * 3) * SMOKE_MORE);
      for (let i = 0; i < cnt; i++) {
        const dly = r() * 0.3;
        const t = (age - dly) / (1.2 - dly);
        const wob = r();
        const size = r();
        if (t <= 0 || t >= 1) continue;
        const px = x + (wob - 0.5) * w * 1.7 * t;
        const py = y - (44 + 96 * vel) * u * t;
        const rad = w * (0.26 + 0.95 * t) * (0.55 + size * 0.85);
        const a = (1 - t) * (1 - t) * 0.4;
        const g = ctx.createRadialGradient(px, py, 0, px, py, rad);
        g.addColorStop(0.0, rgba(mixWhite(c, 0.45), a));
        g.addColorStop(0.55, rgba(mixWhite(c, 0.2), a * 0.45));
        g.addColorStop(1.0, rgba(mixBlack(c, 0.35), 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },

  {
    id: "spark",
    composite: "lighter",
    span: 0.34,
    draw(ctx, hit) {
      const { x, y, w, age, vel, color: c, u, seed } = hit;
      const r = rng(seed * 7919 + 13);
      const k = age / 0.34;
      const flick = [1, 0.35, 0.9, 0.2, 0.55][Math.min(4, Math.floor(k * 5))];
      const fade = (1 - k) * flick;
      if (fade <= 0) return;

      const lite = mixWhite(c, 0.78);
      const cnt = 3 + Math.floor(vel * 4);
      ctx.shadowColor = rgba(lite, fade);
      ctx.shadowBlur = 7 * u;
      ctx.lineCap = "round";
      for (let i = 0; i < cnt; i++) {
        const ang = -Math.PI / 2 + (r() - 0.5) * 2.5;
        const len = w * (0.9 + r() * 2.0) * (0.5 + vel * 0.85) * k;
        ctx.strokeStyle = rgba(i % 2 ? lite : mixWhite(c, 0.95), fade * (0.55 + r() * 0.45));
        ctx.lineWidth = Math.max(0.4, 1.5 - 0.9 * k) * u;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let st = 1; st <= 3; st++) {
          const f = st / 3;
          const jit = (r() - 0.5) * w * 0.55 * (st < 3 ? 1 : 0.4);
          ctx.lineTo(x + Math.cos(ang) * len * f + jit, y + Math.sin(ang) * len * f);
        }
        ctx.stroke();
      }
      ctx.lineCap = "butt";
      ctx.shadowBlur = 0;
    },
  },

  {
    id: "nova",
    composite: "lighter",
    span: 0.55,
    draw(ctx, hit) {
      const { x, y, w, age, vel, color: c, u } = hit;
      const k = age / 0.55;
      const lite = mixWhite(c, 0.72);
      const pow = (0.6 + vel * 0.7) * NOVA_SCALE;

      const core = Math.exp(-age * 14);
      const crad = w * (0.55 + 2.4 * core) * pow;
      const rg = ctx.createRadialGradient(x, y, 0, x, y, crad);
      rg.addColorStop(0.0, `rgba(255,255,255,${core * 0.95})`);
      rg.addColorStop(0.3, rgba(lite, core * 0.7));
      rg.addColorStop(1.0, rgba(c, 0));
      ctx.fillStyle = rg;
      ctx.fillRect(x - crad, y - crad, crad * 2, crad);

      const spike = Math.sin(Math.PI * Math.min(1, k * 2.2));
      if (spike > 0) {
        const len = w * 4.6 * pow * spike;
        const half = w * 0.16 * spike;
        ctx.fillStyle = rgba(mixWhite(c, 0.85), spike * 0.55);
        for (const a of NOVA_SPIKES) {
          const dx = Math.cos(a), dy = Math.sin(a);
          ctx.beginPath();
          ctx.moveTo(x + dx * len, y + dy * len);
          ctx.lineTo(x - dy * half, y + dx * half);
          ctx.lineTo(x + dy * half, y - dx * half);
          ctx.closePath();
          ctx.fill();
        }
      }

      if (k < 1) {
        const rad = w * (0.4 + 4.2 * k) * pow;
        const fade = (1 - k) * (1 - k);
        ctx.strokeStyle = rgba(lite, fade * 0.6);
        ctx.lineWidth = (2.4 * fade + 0.3) * u;
        ctx.beginPath();
        ctx.arc(x, y, rad, Math.PI, Math.PI * 2);
        ctx.stroke();
      }
    },
  },

  {
    id: "shatter",
    composite: "source-over",
    span: 0.6,
    draw(ctx, hit) {
      const { x, y, w, age, vel, color: c, u, seed } = hit;
      const r = rng(seed * 3163 + 5);

      const fl = 1 - age / 0.12;
      if (fl > 0) {
        ctx.fillStyle = rgba(mixWhite(c, 0.6), 0.5 * fl);
        const fw = w * (0.9 + 0.7 * (1 - fl));
        ctx.fillRect(x - fw / 2, y - 4 * u * fl, fw, 4 * u * fl);
      }

      const cnt = 5 + Math.floor(vel * 6);
      for (let i = 0; i < cnt; i++) {
        const ang = -Math.PI / 2 + (r() - 0.5) * 2.2;
        const sp = (70 + r() * 190 * vel) * u;
        const size = (2.6 + r() * 4.2) * u;
        const spin = (r() - 0.5) * 22;
        const life = 1 - age / (0.3 + r() * 0.3);
        if (life <= 0) continue;

        const px = x + Math.cos(ang) * sp * age;
        const py = y + Math.sin(ang) * sp * age + 0.5 * BURST_G * u * age * age;
        const rot = spin * age;

        ctx.fillStyle = rgba(mixWhite(c, 0.55 * life), 0.95 * life);
        ctx.beginPath();
        for (let v = 0; v < 3; v++) {
          const a = rot + v * 2.4 + 0.6;
          const d = size * (v === 1 ? 1.5 : 1) * life;
          const vx = px + Math.cos(a) * d;
          const vy = py + Math.sin(a) * d;
          if (v === 0) ctx.moveTo(vx, vy);
          else ctx.lineTo(vx, vy);
        }
        ctx.closePath();
        ctx.fill();
      }
    },
  },

  {
    id: "ember",
    composite: "lighter",
    span: 1.6,
    draw(ctx, hit) {
      const { x, y, w, age, vel, color: c, u, seed } = hit;
      const r = rng(seed * 8867 + 17);

      const bed = 1 - age / 0.3;
      if (bed > 0) {
        const brad = w * (0.6 + 0.9 * (1 - bed)) * (0.6 + vel * 0.6);
        const bg = ctx.createRadialGradient(x, y, 0, x, y, brad);
        bg.addColorStop(0, rgba(mixWhite(c, 0.65), bed * 0.8));
        bg.addColorStop(0.45, rgba(c, bed * 0.4));
        bg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = bg;
        ctx.fillRect(x - brad, y - brad, brad * 2, brad);
      }

      const cnt = 5 + Math.floor(vel * 7);
      for (let i = 0; i < cnt; i++) {
        const dly = r() * 0.35;
        const lane = r();
        const sway = r();
        const size = r();
        const t = (age - dly) / (1.6 - dly);
        if (t <= 0 || t >= 1) continue;

        const py = y - (70 + 150 * vel) * u * Math.pow(t, EMBER_EASE);
        const px = x + (lane - 0.5) * w * 0.8
          + Math.sin(t * EMBER_FLICKER + sway * 6.283) * w * 0.45 * t;
        const heat = 1 - t;
        const col = heat > 0.5
          ? mixWhite(c, (heat - 0.5) * 1.3)
          : mixBlack(c, (0.5 - heat) * 1.4);
        const flick = 0.72 + 0.28 * Math.sin(t * EMBER_FLICKER * 6.283 + sway * 11);
        const alpha = (1 - t) * (1 - t) * flick * 0.9;
        const rad = (0.8 + size * 1.4) * u * (0.45 + 0.55 * heat);

        ctx.fillStyle = rgba(col, alpha);
        ctx.shadowColor = rgba(mixWhite(c, 0.35), alpha * heat);
        ctx.shadowBlur = 6 * u;
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    },
  },

  {
    id: "splash",
    composite: "lighter",
    span: 0.9,
    draw(ctx, hit) {
      const { x, y, w, age, vel, color: c, u, seed } = hit;
      const r = rng(seed * 2699 + 23);
      const foam = mixWhite(c, 0.75);
      const pow = 0.6 + vel * 0.6;

      const crown = 1 - age / SPLASH_CROWN;
      if (crown > 0) {
        const rad = w * (0.45 + 1.3 * (1 - crown)) * pow;
        const hgt = w * 0.85 * crown * pow;
        ctx.strokeStyle = rgba(foam, crown * 0.8);
        ctx.lineWidth = (1.8 * crown + 0.3) * u;
        ctx.beginPath();
        ctx.moveTo(x - rad, y);
        ctx.lineTo(x - rad * 0.62, y - hgt);
        ctx.moveTo(x + rad, y);
        ctx.lineTo(x + rad * 0.62, y - hgt);
        ctx.stroke();
      }

      const jet = age < SPLASH_JET ? Math.sin(Math.PI * age / SPLASH_JET) : 0;
      if (jet > 0) {
        const hgt = w * 2.3 * jet * pow;
        const bw = w * 0.34 * (0.5 + 0.5 * jet);
        const tw = bw * 0.35;
        ctx.fillStyle = rgba(foam, jet * 0.55);
        ctx.beginPath();
        ctx.moveTo(x - bw / 2, y);
        ctx.lineTo(x + bw / 2, y);
        ctx.lineTo(x + tw / 2, y - hgt);
        ctx.lineTo(x - tw / 2, y - hgt);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y - hgt, tw * 0.9 + 0.4 * u, 0, Math.PI * 2);
        ctx.fill();
      }

      const cnt = 6 + Math.floor(vel * 8);
      for (let i = 0; i < cnt; i++) {
        const life = r();
        const side = r();
        const size = r();
        const tl = (0.3 + life * 0.42) * (0.75 + vel * 0.4);
        if (age >= tl) continue;
        const vy = SPLASH_G * u * tl / 2;
        const vx = (side - 0.5) * w * 5.5 * pow;
        const px = x + vx * age;
        const py = y - vy * age + 0.5 * SPLASH_G * u * age * age;
        const fade = Math.min(1, (tl - age) / 0.12);
        const rad = (0.9 + size * 1.6) * u;
        ctx.fillStyle = rgba(foam, fade * 0.85);
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.fill();
      }

      const k = age / 0.9;
      if (k < 1) {
        const rad = w * (0.4 + 3.0 * k) * pow;
        const fade = (1 - k) * (1 - k);
        ctx.strokeStyle = rgba(c, fade * 0.55);
        ctx.lineWidth = (1.8 * fade + 0.3) * u;
        ctx.beginPath();
        ctx.arc(x, y, rad, Math.PI, Math.PI * 2);
        ctx.stroke();
      }
    },
  },

  {
    id: "none",
    composite: "lighter",
    span: 0,
    draw() {},
  },
];

const pick = (list, id) => list.find(s => s.id === id) ?? list[0];

export const noteStyle = id => pick(NOTE_STYLES, id);
export const hitFx = id => pick(HIT_FX, id);
