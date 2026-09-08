"use client";

import { useEffect, useRef } from "react";

/**
 * Ascii Field — the 21st.dev "Asthetic" ASCII-art effect, reimplemented on
 * Canvas2D.
 *
 * The recipe samples a source photo into a grid of cells and redraws each cell
 * as a glyph or primitive sized by that cell's luminance. Two departures from
 * the recipe as written, both deliberate:
 *
 * 1. There is no source photo. `public/images` was emptied when the TailGrids
 *    demo assets were removed for licensing, and dropping a stock photo back
 *    in would reintroduce exactly that problem. So the subject is drawn
 *    procedurally — the Tripwire mark, two posts and a taut wire with the
 *    trigger node at its centre, which is the site's own idea and has the
 *    strong light/dark structure the sampler needs. Pass `src` to use a real
 *    image instead; nothing else changes.
 *
 * 2. `matrix` is specced as *green* code rain. Green fights a page that is
 *    white-on-black with a single accent blue, so RAIN_HUE carries the accent
 *    instead. One constant, if literal green is ever wanted.
 *
 * The subject is static, so it is sampled once per resize rather than per
 * frame; only the animation and the glyph choice move. Honours
 * `prefers-reduced-motion` by drawing a single frame.
 */

type RenderMode =
  | "characters" | "dither" | "mosaic" | "pixel" | "dots" | "cross"
  | "diamond" | "voxel" | "lego" | "mixed" | "lines" | "diagonal"
  | "braille" | "disco" | "hexdump" | "matrix" | "rings" | "hearts"
  | "stars" | "hexagons" | "triangles" | "bubbles" | "hatch"
  | "contour" | "halfblocks";

const CHAR_SETS = {
  standard: " .:-=+*#%@",
  blocks: " ░▒▓█",
  hex: "0123456789ABCDEF",
  matrix: "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ" + "0123456789",
};

/** The recipe's parameter block, verbatim. */
const CONFIG = {
  renderMode: "matrix" as RenderMode,
  bgMode: "blur" as "blur" | "color" | "photo" | "none",
  bgBlur: 0,
  bgOpacity: 40,
  cellSize: 11,
  coverage: 100,
  invert: false,
  styleBlend: "lighter" as GlobalCompositeOperation,
  charSet: "standard" as keyof typeof CHAR_SETS,
  customChars: "",
  brightness: 12,
  contrast: 115,
  edgeEmphasis: 0,
  density: 0,
  tint: "#3ca6ff",
  tintOpacity: 0,
  overlayBlend: "multiply" as GlobalCompositeOperation,
  saturation: 100,
  grayscale: 0,
  blurType: "off" as "off" | "gaussian",
  blurAmount: 35,
  pfx: {
    vignette: { enabled: true, intensity: 38 },
    scanLines: { enabled: false, intensity: 40 },
    chromatic: { enabled: false, intensity: 15 },
    bloom: { enabled: true, intensity: 25 },
    filmGrain: { enabled: false, intensity: 30 },
    glitch: { enabled: false, intensity: 20 },
    pixelate: { enabled: false, intensity: 15 },
    halftone: { enabled: false, intensity: 20 },
    filmDust: { enabled: false, intensity: 20 },
  },
  animated: true,
  animStyle: "wave" as "wave" | "pulse" | "shimmer" | "ripple" | "flicker",
  animSpeed: { enabled: true, intensity: 100 },
  animIntensity: { enabled: true, intensity: 60 },
  lights: {
    enabled: false,
    points: [] as { x: number; y: number; radius: number; intensity: number }[],
  },
  mask: { enabled: false, dataUrl: null as string | null, invert: false },
};

/** The site accent, standing in for the recipe's matrix green. */
const RAIN_HUE = { r: 88, g: 166, b: 255 };

/** Feather, as a fraction of each axis, so the field melts into the page. */
const FADE_X = 0.1;
const FADE_Y = 0.16;

const TAU = Math.PI * 2;

/**
 * The edge feather, as a compositor mask rather than two `destination-in`
 * gradient fills per frame. Both axes are masked and intersected, so the
 * corners fall off on both — the same result RibbonField gets in canvas, at no
 * per-frame cost.
 */
const MASK_STYLE: React.CSSProperties = {
  maskImage: [
    `linear-gradient(to bottom, transparent 0%, black ${FADE_Y * 100}%, black ${(1 - FADE_Y) * 100}%, transparent 100%)`,
    `linear-gradient(to right, transparent 0%, black ${FADE_X * 100}%, black ${(1 - FADE_X) * 100}%, transparent 100%)`,
  ].join(", "),
  maskComposite: "intersect",
  WebkitMaskComposite: "source-in",
} as React.CSSProperties;

/** The `pfx.vignette` post-effect, likewise static and likewise free in CSS. */
const VIGNETTE_STYLE: React.CSSProperties = {
  background: `radial-gradient(ellipse at center, transparent 20%, rgba(0,0,0,${
    CONFIG.pfx.vignette.intensity / 100
  }) 100%)`,
};

/** Deterministic PRNG — the rain is identical across reloads. */
function hash(x: number, y: number, z: number): number {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^
    Math.imul(y | 0, 0x165667b1) ^
    Math.imul(z | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
}

/**
 * The subject, drawn rather than photographed: the Tripwire mark at scale, lit
 * so the sampler has a real luminance gradient to read instead of flat fills.
 */
function paintSubject(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const span = Math.min(w * 0.66, h * 1.9);

  // Ambient falloff, so cells away from the mark are not uniformly dead.
  const ambient = ctx.createRadialGradient(cx, cy, 0, cx, cy, span * 0.8);
  ambient.addColorStop(0, "rgba(120,150,200,0.42)");
  ambient.addColorStop(0.55, "rgba(60,86,140,0.16)");
  ambient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = ambient;
  ctx.fillRect(0, 0, w, h);

  const half = span / 2;
  const postH = Math.min(h * 0.42, span * 0.3);
  ctx.lineCap = "round";

  // Soften the geometry before it is sampled. A photograph has no hard 2px
  // edges, and the recipe's `bgMode: "blur"` paints this same raster as the
  // backing plate — left crisp, the posts and wire read as stray layout rules
  // rather than as an image. Blurred, they become light and the sampler still
  // finds all the structure it needs.
  ctx.filter = `blur(${Math.max(2, span * 0.018)}px)`;

  // The two posts.
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = Math.max(2, span * 0.012);
  for (const x of [cx - half, cx + half]) {
    ctx.beginPath();
    ctx.moveTo(x, cy - postH);
    ctx.lineTo(x, cy + postH);
    ctx.stroke();
  }

  // The wire, brightest at the centre where the trigger sits.
  const wire = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
  wire.addColorStop(0, "rgba(255,255,255,0.55)");
  wire.addColorStop(0.5, "rgba(255,255,255,1)");
  wire.addColorStop(1, "rgba(255,255,255,0.55)");
  ctx.strokeStyle = wire;
  ctx.lineWidth = Math.max(1.5, span * 0.008);
  ctx.beginPath();
  ctx.moveTo(cx - half, cy);
  ctx.lineTo(cx + half, cy);
  ctx.stroke();

  // The trigger node, and its glow.
  const nodeR = Math.max(6, span * 0.038);
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, nodeR * 5);
  glow.addColorStop(0, "rgba(255,255,255,0.85)");
  glow.addColorStop(0.35, "rgba(150,190,255,0.4)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, nodeR * 5, 0, TAU);
  ctx.fill();

  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(cx, cy, nodeR, 0, TAU);
  ctx.fill();

  ctx.filter = "none";
}

type Cell = { r: number; g: number; b: number; lum: number; edge: number };

export default function AsciiField({
  className,
  src,
}: {
  className?: string;
  src?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    // The source raster, and the layer the effect is composited on.
    const source = document.createElement("canvas");
    const sourceCtx = source.getContext("2d", { willReadFrequently: true })!;
    const layer = document.createElement("canvas");
    const layerCtx = layer.getContext("2d")!;
    // Quarter-size scratch for the bloom. Blur cost scales with area, so
    // blurring here instead of on the full layer is ~16x cheaper and, being a
    // blur, indistinguishable once it is scaled back up.
    const scratch = document.createElement("canvas");
    const scratchCtx = scratch.getContext("2d")!;

    // Assigning ctx.font is expensive and dominates a glyph-per-cell loop, so
    // it is only written when the string actually changes. Canvas state resets
    // whenever the backing store is resized, hence the reset in `resize`.
    let currentFont = "";
    const setFont = (c: CanvasRenderingContext2D, f: string) => {
      if (f !== currentFont) {
        c.font = f;
        currentFont = f;
      }
    };

    // Rain fills, pre-built per alpha step. Building an rgba string per cell
    // churned enough short-lived strings to show up in frame time.
    const RAIN_STEPS = 32;
    const rainFills: [string[], string[]] = [[], []];
    for (let i = 0; i < RAIN_STEPS; i++) {
      const a = ((i + 1) / RAIN_STEPS).toFixed(3);
      rainFills[0].push(`rgba(${RAIN_HUE.r},${RAIN_HUE.g},${RAIN_HUE.b},${a})`);
      rainFills[1].push(`rgba(255,255,255,${a})`);
    }

    let photo: HTMLImageElement | null = null;
    let width = 0;
    let height = 0;
    let cols = 0;
    let rows = 0;
    let cells: Cell[] = [];

    const chars = CONFIG.customChars || CHAR_SETS[CONFIG.charSet];
    const rainChars = CHAR_SETS.matrix;

    /** Steps 1 + 4: draw the source, with the colour adjustments applied. */
    const paintSource = () => {
      const { brightness, contrast, saturation, grayscale } = CONFIG;
      sourceCtx.setTransform(1, 0, 0, 1, 0, 0);
      sourceCtx.filter =
        `brightness(${1 + brightness / 100}) contrast(${contrast}%) ` +
        `saturate(${saturation}%) grayscale(${grayscale}%)`;

      if (photo) {
        // Cover-fit, so the subject is never squashed.
        const scale = Math.max(width / photo.width, height / photo.height);
        const dw = photo.width * scale;
        const dh = photo.height * scale;
        sourceCtx.clearRect(0, 0, width, height);
        sourceCtx.drawImage(photo, (width - dw) / 2, (height - dh) / 2, dw, dh);
      } else {
        paintSubject(sourceCtx, width, height);
      }
      sourceCtx.filter = "none";
    };

    /** Step 2: average each cell, and record a cheap edge score alongside. */
    const sample = () => {
      const { data } = sourceCtx.getImageData(0, 0, width, height);
      const cell = CONFIG.cellSize;
      cells = new Array(cols * rows);

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x0 = col * cell;
          const y0 = row * cell;
          const x1 = Math.min(x0 + cell, width);
          const y1 = Math.min(y0 + cell, height);

          let r = 0;
          let g = 0;
          let b = 0;
          let n = 0;
          let min = 1;
          let max = 0;

          for (let y = y0; y < y1; y += 2) {
            for (let x = x0; x < x1; x += 2) {
              const i = (y * width + x) * 4;
              r += data[i];
              g += data[i + 1];
              b += data[i + 2];
              const l =
                (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) /
                255;
              if (l < min) min = l;
              if (l > max) max = l;
              n++;
            }
          }

          if (!n) n = 1;
          r /= n;
          g /= n;
          b /= n;
          let lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
          if (CONFIG.invert) lum = 1 - lum;

          cells[row * cols + col] = { r, g, b, lum, edge: max - min };
        }
      }
    };

    /** Step 8: how much this cell is pushed around at time `t`. */
    const animate = (col: number, row: number, t: number): number => {
      if (!CONFIG.animated || reduceMotion) return 0;
      const amt =
        (CONFIG.animIntensity.enabled ? CONFIG.animIntensity.intensity : 0) /
        100;
      if (!amt) return 0;

      switch (CONFIG.animStyle) {
        case "wave":
          return (
            Math.sin((col / cols) * TAU * 1.6 - t * 1.4 + (row / rows) * 1.2) *
            0.28 *
            amt
          );
        case "pulse":
          return Math.sin(t * 1.8) * 0.3 * amt;
        case "shimmer":
          return (hash(col, row, Math.floor(t * 6)) - 0.5) * 0.5 * amt;
        case "ripple": {
          const dx = col / cols - 0.5;
          const dy = row / rows - 0.5;
          return Math.sin(Math.hypot(dx, dy) * 18 - t * 2.4) * 0.3 * amt;
        }
        case "flicker":
          return (hash(col, row, Math.floor(t * 10)) > 0.86 ? -0.45 : 0) * amt;
      }
      return 0;
    };

    /** Step 3: one primitive per cell, chosen by render mode. */
    const drawCell = (
      c: CanvasRenderingContext2D,
      mode: RenderMode,
      x: number,
      y: number,
      s: number,
      v: number,
      cell: Cell,
      col: number,
      row: number,
      t: number,
    ) => {
      const half = s / 2;
      const mx = x + half;
      const my = y + half;
      const r = half * v;

      switch (mode) {
        case "characters":
          // Quantised to 8 sizes so `setFont` almost always short-circuits.
          setFont(
            c,
            `${(s * (0.7 + (((v * 8) | 0) / 8) * 0.4)).toFixed(1)}px ui-monospace, monospace`,
          );
          c.fillText(
            chars[Math.min(chars.length - 1, (v * (chars.length - 1)) | 0)],
            mx,
            my,
          );
          break;

        // "matrix" is handled by drawMatrix — it is the one self-animated mode,
        // so it is driven by column rather than by grid scan.

        case "dither": {
          // 4x4 ordered Bayer — the cell is on or off, never grey.
          const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
          if (v > bayer[(row % 4) * 4 + (col % 4)] / 16) c.fillRect(x, y, s, s);
          break;
        }

        case "mosaic":
          c.fillRect(x, y, s * 0.86, s * 0.86);
          break;

        case "pixel":
          c.fillRect(x, y, s, s);
          break;

        case "dots":
          c.beginPath();
          c.arc(mx, my, r, 0, TAU);
          c.fill();
          break;

        case "cross":
          c.lineWidth = Math.max(0.5, s * 0.14 * v);
          c.beginPath();
          c.moveTo(mx - r, my);
          c.lineTo(mx + r, my);
          c.moveTo(mx, my - r);
          c.lineTo(mx, my + r);
          c.stroke();
          break;

        case "diamond":
          c.beginPath();
          c.moveTo(mx, my - r);
          c.lineTo(mx + r, my);
          c.lineTo(mx, my + r);
          c.lineTo(mx - r, my);
          c.closePath();
          c.fill();
          break;

        case "voxel": {
          // An isometric cube whose height tracks luminance.
          const d = half * 0.5;
          const top = my - v * s * 0.5;
          c.beginPath();
          c.moveTo(mx, top - d);
          c.lineTo(mx + half, top);
          c.lineTo(mx, top + d);
          c.lineTo(mx - half, top);
          c.closePath();
          c.fill();
          c.globalAlpha *= 0.55;
          c.fillRect(mx - half, top, half, my + d - top);
          c.globalAlpha /= 0.55;
          break;
        }

        case "lego":
          c.fillRect(x, y, s, s);
          c.globalAlpha *= 0.5;
          c.beginPath();
          c.arc(mx, my, s * 0.22, 0, TAU);
          c.fill();
          c.globalAlpha /= 0.5;
          break;

        case "mixed":
          drawCell(
            c,
            (["dots", "diamond", "cross", "pixel"] as RenderMode[])[
              (hash(col, row, 2) * 4) | 0
            ],
            x, y, s, v, cell, col, row, t,
          );
          break;

        case "lines":
          c.lineWidth = Math.max(0.5, s * v * 0.8);
          c.beginPath();
          c.moveTo(x, my);
          c.lineTo(x + s, my);
          c.stroke();
          break;

        case "diagonal":
          c.lineWidth = Math.max(0.5, s * v * 0.6);
          c.beginPath();
          c.moveTo(x, y + s);
          c.lineTo(x + s, y);
          c.stroke();
          break;

        case "braille": {
          // 2x4 dot matrix, filled in reading order by luminance.
          const on = Math.round(v * 8);
          for (let i = 0; i < on; i++) {
            c.beginPath();
            c.arc(
              x + s * (0.3 + (i % 2) * 0.4),
              y + s * (0.16 + ((i / 2) | 0) * 0.24),
              s * 0.09,
              0,
              TAU,
            );
            c.fill();
          }
          break;
        }

        case "disco":
          c.fillStyle = `hsla(${(hash(col, row, 5) * 360 + t * 60) % 360},80%,${
            30 + v * 45
          }%,${v})`;
          c.beginPath();
          c.arc(mx, my, r, 0, TAU);
          c.fill();
          break;

        case "hexdump":
          setFont(c, `${(s * 0.8).toFixed(1)}px ui-monospace, monospace`);
          c.fillText(CHAR_SETS.hex[Math.min(15, (v * 16) | 0)], mx, my);
          break;

        case "rings":
          c.lineWidth = Math.max(0.5, s * 0.12);
          c.beginPath();
          c.arc(mx, my, Math.max(0.5, r), 0, TAU);
          c.stroke();
          break;

        case "hearts": {
          const k = r * 0.9;
          c.beginPath();
          c.moveTo(mx, my + k * 0.8);
          c.bezierCurveTo(
            mx - k * 1.6, my - k * 0.4,
            mx - k * 0.5, my - k * 1.2,
            mx, my - k * 0.35,
          );
          c.bezierCurveTo(
            mx + k * 0.5, my - k * 1.2,
            mx + k * 1.6, my - k * 0.4,
            mx, my + k * 0.8,
          );
          c.fill();
          break;
        }

        case "stars": {
          c.beginPath();
          for (let i = 0; i < 10; i++) {
            const rad = i % 2 ? r * 0.45 : r;
            const a = (i / 10) * TAU - Math.PI / 2;
            const px = mx + Math.cos(a) * rad;
            const py = my + Math.sin(a) * rad;
            if (i) c.lineTo(px, py);
            else c.moveTo(px, py);
          }
          c.closePath();
          c.fill();
          break;
        }

        case "hexagons":
          c.beginPath();
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * TAU;
            const px = mx + Math.cos(a) * r;
            const py = my + Math.sin(a) * r;
            if (i) c.lineTo(px, py);
            else c.moveTo(px, py);
          }
          c.closePath();
          c.fill();
          break;

        case "triangles":
          c.beginPath();
          if ((col + row) % 2) {
            c.moveTo(x, y);
            c.lineTo(x + s, y);
            c.lineTo(x, y + s);
          } else {
            c.moveTo(x + s, y + s);
            c.lineTo(x, y + s);
            c.lineTo(x + s, y);
          }
          c.closePath();
          c.fill();
          break;

        case "bubbles":
          c.lineWidth = Math.max(0.5, s * 0.09);
          c.beginPath();
          c.arc(mx, my, Math.max(0.5, r), 0, TAU);
          c.stroke();
          c.globalAlpha *= 0.6;
          c.beginPath();
          c.arc(mx - r * 0.3, my - r * 0.3, Math.max(0.4, r * 0.22), 0, TAU);
          c.fill();
          c.globalAlpha /= 0.6;
          break;

        case "hatch":
          // Pencil cross-hatch: the second pass appears only in the lit half.
          c.lineWidth = Math.max(0.4, s * 0.07);
          c.beginPath();
          c.moveTo(x, y + s);
          c.lineTo(x + s, y);
          if (v > 0.5) {
            c.moveTo(x, y);
            c.lineTo(x + s, y + s);
          }
          c.stroke();
          break;

        case "contour": {
          // Topographic iso-line: drawn only where luminance crosses a band.
          const bands = 7;
          const band = v * bands;
          if (Math.abs(band - Math.round(band)) > 0.16) return;
          c.lineWidth = Math.max(0.5, s * 0.1);
          c.beginPath();
          c.arc(mx, my, Math.max(0.5, half * 0.8), 0, TAU);
          c.stroke();
          break;
        }

        case "halfblocks":
          // Two half-height samples per cell, for double vertical detail.
          c.fillRect(x, y, s, (s / 2) * v);
          c.fillRect(x, y + s / 2, s, (s / 2) * (cell.edge > 0.1 ? 1 - v : v));
          break;
      }
    };

    /**
     * Code rain, driven per column instead of per cell.
     *
     * Every other mode reads as a grid scan, but rain is a column of glyphs
     * with a bright head and a decaying tail — and only the cells inside a
     * trail are ever drawn. Scanning the whole grid meant evaluating ~7,700
     * cells to draw ~1,800 of them, and paying three PRNG calls per cell for
     * three values that only depend on the column. Walking the trail directly
     * costs what it draws.
     */
    const drawMatrix = (c: CanvasRenderingContext2D, t: number, s: number) => {
      const half = s / 2;
      const cover = CONFIG.coverage / 100;
      const densityK = 1 + CONFIG.density / 100;
      const edgeK = CONFIG.edgeEmphasis / 100;
      setFont(c, `${(s * 0.92).toFixed(1)}px ui-monospace, monospace`);
      c.globalAlpha = 1;

      for (let col = 0; col < cols; col++) {
        // Per-column, not per-cell: speed, trail length and phase offset.
        const speed = 4 + hash(col, 0, 7) * 9;
        const len = 7 + hash(col, 0, 11) * 14;
        const head = (t * speed + hash(col, 0, 3) * rows) % (rows + len);
        const from = Math.max(0, Math.ceil(head - len));
        const to = Math.min(rows - 1, Math.floor(head));
        const mx = col * s + half;

        for (let row = from; row <= to; row++) {
          if (cover < 1 && hash(col, row, 1) > cover) continue;

          const cell = cells[row * cols + col];
          let v = cell.lum * densityK + cell.edge * edgeK + animate(col, row, t);
          v = v < 0 ? 0 : v > 1 ? 1 : v;

          // The subject gates the rain, so the mark reads through it rather
          // than being buried by it.
          const tail = 1 - (head - row) / len;
          const a = Math.min(1, tail * tail * (0.25 + v * 1.1));
          if (a < 0.02) continue;

          // The head is near-white; the tail carries the accent.
          c.fillStyle =
            rainFills[head - row < 1 ? 1 : 0][
              Math.min(RAIN_STEPS - 1, (a * RAIN_STEPS) | 0)
            ];
          c.fillText(
            rainChars[
              (hash(col, row, Math.floor(t * 7 + row)) * rainChars.length) | 0
            ],
            mx,
            row * s + half,
          );
        }
      }
    };

    /** Steps 5–7, plus the edge feather that ties the field into the page. */
    const post = (c: CanvasRenderingContext2D) => {
      const { pfx } = CONFIG;

      if (pfx.bloom.enabled && scratch.width > 0) {
        const k = pfx.bloom.intensity / 100;
        // Downsample, blur small, composite back up.
        scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
        scratchCtx.globalCompositeOperation = "copy";
        scratchCtx.filter = `blur(${1 + k * 2.5}px)`;
        scratchCtx.drawImage(c.canvas, 0, 0, scratch.width, scratch.height);
        scratchCtx.filter = "none";

        c.save();
        c.globalCompositeOperation = "lighter";
        c.globalAlpha = k * 0.7;
        c.drawImage(scratch, 0, 0, width, height);
        c.restore();
      }

      if (pfx.scanLines.enabled) {
        c.save();
        c.globalAlpha = (pfx.scanLines.intensity / 100) * 0.5;
        c.fillStyle = "#000";
        for (let y = 0; y < height; y += 3) c.fillRect(0, y, width, 1);
        c.restore();
      }

      if (pfx.halftone.enabled) {
        c.save();
        c.globalCompositeOperation = "destination-out";
        c.globalAlpha = (pfx.halftone.intensity / 100) * 0.6;
        c.fillStyle = "#000";
        for (let y = 0; y < height; y += 4)
          for (let x = 0; x < width; x += 4) c.fillRect(x, y, 2, 2);
        c.restore();
      }

      if (pfx.filmGrain.enabled) {
        c.save();
        c.globalAlpha = (pfx.filmGrain.intensity / 100) * 0.18;
        for (let i = 0; i < 2400; i++) {
          c.fillStyle = hash(i, 1, 4) > 0.5 ? "#fff" : "#000";
          c.fillRect(hash(i, 2, 5) * width, hash(i, 3, 6) * height, 1, 1);
        }
        c.restore();
      }

      if (pfx.filmDust.enabled) {
        c.save();
        c.globalAlpha = (pfx.filmDust.intensity / 100) * 0.3;
        c.strokeStyle = "#fff";
        c.lineWidth = 0.6;
        for (let i = 0; i < 18; i++) {
          const x = hash(i, 7, 8) * width;
          const y = hash(i, 9, 10) * height;
          c.beginPath();
          c.moveTo(x, y);
          c.lineTo(x + hash(i, 11, 12) * 14 - 7, y + hash(i, 13, 14) * 20);
          c.stroke();
        }
        c.restore();
      }

      // 6. Lights.
      if (CONFIG.lights.enabled) {
        c.save();
        c.globalCompositeOperation = "lighter";
        for (const p of CONFIG.lights.points) {
          const g = c.createRadialGradient(
            p.x * width, p.y * height, 0,
            p.x * width, p.y * height, p.radius,
          );
          g.addColorStop(0, `rgba(255,255,255,${p.intensity / 100})`);
          g.addColorStop(1, "rgba(255,255,255,0)");
          c.fillStyle = g;
          c.fillRect(0, 0, width, height);
        }
        c.restore();
      }

      // The vignette and the edge feather used to be three full-canvas gradient
      // fills here — ~2.8M pixel writes every frame for two masks that never
      // change. They are static, so they moved to CSS (see MASK_STYLE and the
      // vignette overlay below), where the compositor applies them for free.
      // Everything that stays in this function is genuinely per-frame.
    };

    const draw = (t: number) => {
      const sx = layer.width / width;
      const sy = layer.height / height;

      layerCtx.setTransform(1, 0, 0, 1, 0, 0);
      layerCtx.scale(sx, sy);
      layerCtx.globalAlpha = 1;

      // 1. Background. Drawn with `copy` rather than clear-then-draw, which
      //    folds the frame's clear into the same pass.
      if (CONFIG.bgMode === "none") {
        layerCtx.globalCompositeOperation = "copy";
        layerCtx.clearRect(0, 0, width, height);
      } else {
        layerCtx.save();
        layerCtx.globalCompositeOperation = "copy";
        layerCtx.globalAlpha = CONFIG.bgOpacity / 100;
        if (CONFIG.bgMode === "color") {
          layerCtx.fillStyle = CONFIG.tint;
          layerCtx.fillRect(0, 0, width, height);
        } else {
          if (CONFIG.bgMode === "blur" && CONFIG.bgBlur > 0) {
            layerCtx.filter = `blur(${CONFIG.bgBlur}px)`;
          }
          layerCtx.drawImage(source, 0, 0, width, height);
        }
        layerCtx.restore();
      }
      layerCtx.globalCompositeOperation = "source-over";

      // 3. The cells.
      const s = CONFIG.cellSize;
      const cover = CONFIG.coverage / 100;
      const densityK = 1 + CONFIG.density / 100;
      const edgeK = CONFIG.edgeEmphasis / 100;

      layerCtx.save();
      layerCtx.globalCompositeOperation = CONFIG.styleBlend;
      // Glyph alignment is constant for the whole grid — set once, not per cell.
      layerCtx.textAlign = "center";
      layerCtx.textBaseline = "middle";

      if (CONFIG.renderMode === "matrix") {
        drawMatrix(layerCtx, t, s);
      } else {
        let lastColor = "";
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            if (cover < 1 && hash(col, row, 1) > cover) continue;

            const cell = cells[row * cols + col];
            let v =
              cell.lum * densityK + cell.edge * edgeK + animate(col, row, t);
            v = v < 0 ? 0 : v > 1 ? 1 : v;
            if (v < 0.015) continue;

            // Building an `rgb()` string and re-parsing it per cell was the
            // single most expensive thing in this loop. Quantising to 5 bits a
            // channel makes the runs long enough that most cells reuse the
            // previous fill, and the difference is invisible at 11px.
            const color = `rgb(${cell.r & 0xf8},${cell.g & 0xf8},${cell.b & 0xf8})`;
            if (color !== lastColor) {
              layerCtx.fillStyle = color;
              layerCtx.strokeStyle = color;
              lastColor = color;
            }
            layerCtx.globalAlpha = v;
            drawCell(
              layerCtx, CONFIG.renderMode,
              col * s, row * s, s, v, cell, col, row, t,
            );
          }
        }
      }
      layerCtx.restore();

      // 4. Tint, then blur.
      if (CONFIG.tintOpacity > 0) {
        layerCtx.save();
        layerCtx.globalCompositeOperation = CONFIG.overlayBlend;
        layerCtx.globalAlpha = CONFIG.tintOpacity / 100;
        layerCtx.fillStyle = CONFIG.tint;
        layerCtx.fillRect(0, 0, width, height);
        layerCtx.restore();
      }
      if (CONFIG.blurType !== "off" && CONFIG.blurAmount > 0) {
        layerCtx.save();
        layerCtx.setTransform(1, 0, 0, 1, 0, 0);
        layerCtx.filter = `blur(${(CONFIG.blurAmount / 100) * 12}px)`;
        layerCtx.globalCompositeOperation = "copy";
        layerCtx.drawImage(layer, 0, 0);
        layerCtx.restore();
      }

      // 5-7.
      layerCtx.setTransform(1, 0, 0, 1, 0, 0);
      layerCtx.scale(sx, sy);
      post(layerCtx);

      // Present. `copy` again, so the clear and the blit are one pass.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "copy";
      ctx.drawImage(layer, 0, 0, canvas.width, canvas.height);
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));

      // Capped at 1.5: the glyphs are ~11px, so a full retina buffer costs real
      // frame time and buys nothing visible.
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = layer.width = Math.round(width * dpr);
      canvas.height = layer.height = Math.round(height * dpr);
      source.width = width;
      source.height = height;
      scratch.width = Math.max(1, Math.round(layer.width / 4));
      scratch.height = Math.max(1, Math.round(layer.height / 4));

      // Resizing the backing store resets canvas state, including the font.
      currentFont = "";

      cols = Math.ceil(width / CONFIG.cellSize);
      rows = Math.ceil(height / CONFIG.cellSize);

      paintSource();
      sample();
    };

    let frame = 0;
    let start = 0;
    let last = 0;

    const loop = (now: number) => {
      if (!start) start = now;
      // 30fps is plenty for glyph rain, and halves the per-frame cost.
      if (now - last >= 33) {
        last = now;
        const speed = CONFIG.animSpeed.enabled
          ? CONFIG.animSpeed.intensity / 100
          : 0;
        draw(((now - start) / 1000) * speed);
      }
      frame = requestAnimationFrame(loop);
    };

    const startRendering = () => {
      resize();
      if (reduceMotion || !CONFIG.animated) draw(0);
      else frame = requestAnimationFrame(loop);
    };

    if (src) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        photo = img;
        startRendering();
      };
      // Fall back to the drawn subject rather than rendering nothing.
      img.onerror = () => startRendering();
      img.src = src;
    } else {
      startRendering();
    }

    const observer = new ResizeObserver(() => {
      resize();
      if (reduceMotion || !CONFIG.animated) draw(0);
    });
    observer.observe(canvas);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [src]);

  return (
    <div aria-hidden="true" className={className}>
      <canvas ref={canvasRef} className="block h-full w-full" style={MASK_STYLE} />
      {CONFIG.pfx.vignette.enabled && (
        <div className="pointer-events-none absolute inset-0" style={VIGNETTE_STYLE} />
      )}
    </div>
  );
}
