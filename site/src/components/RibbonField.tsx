"use client";

import { useEffect, useRef } from "react";

/**
 * Ribbon Field — an animated canvas stripe gradient.
 *
 * Ported from the 21st.dev "Purple Animated Waves" preset. The purple ramp is
 * replaced with the site's own accent blue, sampled from the gradient art the
 * template already ships (`Gradient.png` / `shape-4.png` centre on #2A88FF and
 * #3B82ED), so the section reads as part of the page rather than a slab.
 *
 * The field rasterises into a small offscreen buffer and is upscaled onto an
 * opaque compositing canvas — the smooth upscale supplies the `soften` blur.
 * Grain goes on there while it is still opaque, then an alpha mask feathers all
 * four edges so the field dissolves into `bg-theme-dark` instead of ending on a
 * hard line.
 */

// Capped at #2F6FD0 rather than the sampled #3B82ED highlight: the bands sway
// under white copy, and this holds ~4.9:1 against white so the heading and the
// body line stay readable at every phase.
const COLORS = [
  { hex: "#030303", pos: 0 }, // Night — matches the page black, so dark bands vanish
  { hex: "#0D2143", pos: 33 }, // Abyss
  { hex: "#1A4A8F", pos: 67 }, // Deep azure
  { hex: "#2F6FD0", pos: 100 }, // Azure
];

const ANGLE = 155;
const CENTER_X = 50;
const CENTER_Y = 50;
const SCALE = 68;
const SOFTNESS = 26;
const WAVE = 12;
const DISTORTION = 28;
const GRAIN = 16;
const SOFTEN = 4;
const SEED = 1;

// Edge feather, as a fraction of each axis, so the field melts into the page.
const FADE_X = 0.14;
const FADE_Y = 0.24;

const SPEED = 98; // ph = t * 0.98
const MOTION_AMOUNT = 75; // amt = 0.75
const MOTION_REVERSE = false;
const WAVE_CLOCK_BASE = 20.75;

const TAU = Math.PI * 2;
const LUT_SIZE = 1024;

type Rgb = { r: number; g: number; b: number };

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * Colour ramp for the stripe field: each colour holds flat across its band and
 * the boundaries between bands are feathered by `softness`.
 */
function buildLut(): Uint8ClampedArray {
  const stops = COLORS.map((c) => ({ ...hexToRgb(c.hex), pos: c.pos }));
  const bounds = stops.slice(0, -1).map((stop, i) => ({
    at: (stop.pos + stops[i + 1].pos) / 2,
    half: ((SOFTNESS / 100) * (stops[i + 1].pos - stop.pos)) / 2,
  }));

  const lut = new Uint8ClampedArray(LUT_SIZE * 3);

  for (let i = 0; i < LUT_SIZE; i++) {
    const q = (i / (LUT_SIZE - 1)) * 100;

    let band = 0;
    while (band < bounds.length && q >= bounds[band].at) band++;

    const prev = bounds[band - 1];
    const next = bounds[band];
    let from = stops[band];
    let to = stops[band];
    let k = 0;

    if (prev && prev.half > 0 && q < prev.at + prev.half) {
      from = stops[band - 1];
      to = stops[band];
      k = (q - (prev.at - prev.half)) / (2 * prev.half);
    } else if (next && next.half > 0 && q > next.at - next.half) {
      from = stops[band];
      to = stops[band + 1];
      k = (q - (next.at - next.half)) / (2 * next.half);
    }

    lut[i * 3] = from.r + (to.r - from.r) * k;
    lut[i * 3 + 1] = from.g + (to.g - from.g) * k;
    lut[i * 3 + 2] = from.b + (to.b - from.b) * k;
  }

  return lut;
}

/** Deterministic PRNG so the grain tile is identical across reloads. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildGrainTile(): HTMLCanvasElement {
  const size = 120;
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;

  const ctx = tile.getContext("2d")!;
  const image = ctx.createImageData(size, size);
  const rand = mulberry32(SEED);

  for (let i = 0; i < image.data.length; i += 4) {
    const v = rand() * 255;
    image.data[i] = v;
    image.data[i + 1] = v;
    image.data[i + 2] = v;
    image.data[i + 3] = 255;
  }

  ctx.putImageData(image, 0, 0);
  return tile;
}

export default function RibbonField({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const lut = buildLut();
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    // Low-res buffer the field is rasterised into.
    const buffer = document.createElement("canvas");
    const bufferCtx = buffer.getContext("2d")!;
    let image: ImageData | null = null;

    // Full-res opaque canvas where grain is blended and the edge mask applied.
    const layer = document.createElement("canvas");
    const layerCtx = layer.getContext("2d")!;
    const grain = layerCtx.createPattern(buildGrainTile(), "repeat");

    let width = 0;
    let height = 0;
    let bufferW = 0;
    let bufferH = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));

      for (const c of [canvas, layer]) {
        c.width = Math.round(width * dpr);
        c.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // ~1/6 scale keeps the per-pixel loop cheap; the feathered edges are far
      // wider than a buffer pixel, so nothing visible is lost.
      bufferW = Math.min(320, Math.max(64, Math.round(width / 6)));
      bufferH = Math.max(2, Math.round((bufferW * height) / width));
      buffer.width = bufferW;
      buffer.height = bufferH;
      image = bufferCtx.createImageData(bufferW, bufferH);
    };

    const draw = (ph: number) => {
      if (!image) return;

      const amt = MOTION_AMOUNT / 100;
      const dir = MOTION_REVERSE ? -1 : 1;
      const spin = ph * dir;

      // Hard bands sway rather than spin. sin(0) === 0, so ph = 0 is the
      // unmodulated angle and motion starts without a snap.
      const angle = ANGLE + Math.sin(spin * 0.6) * 28 * amt;
      const waveClock = WAVE_CLOCK_BASE + ph * 1.2;

      const th = (angle * Math.PI) / 180;
      const dx = Math.sin(th);
      const dy = -Math.cos(th);

      const gradientLength =
        Math.abs(width * Math.sin(th)) + Math.abs(height * Math.cos(th));
      const span = (gradientLength * SCALE) / 100 || 1;
      const cx = (width * CENTER_X) / 100;
      const cy = (height * CENTER_Y) / 100;

      const waveAmp = (WAVE / 100) * 0.35;
      const distortAmp = (DISTORTION / 100) * 0.1;

      const data = image.data;
      const stepX = width / bufferW;
      const stepY = height / bufferH;

      for (let py = 0; py < bufferH; py++) {
        const oy = (py + 0.5) * stepY - cy;

        for (let px = 0; px < bufferW; px++) {
          const ox = (px + 0.5) * stepX - cx;

          let p = (ox * dx + oy * dy) / span + 0.5;
          const cross = (ox * -dy + oy * dx) / span;

          p += waveAmp * Math.sin(cross * 2.4 * TAU + waveClock);
          p += distortAmp * Math.sin(cross * 0.9 * TAU + waveClock * 0.5 + 2.1);

          const idx =
            (p <= 0 ? 0 : p >= 1 ? LUT_SIZE - 1 : (p * (LUT_SIZE - 1)) | 0) * 3;

          const o = (py * bufferW + px) * 4;
          data[o] = lut[idx];
          data[o + 1] = lut[idx + 1];
          data[o + 2] = lut[idx + 2];
          data[o + 3] = 255;
        }
      }

      bufferCtx.putImageData(image, 0, 0);

      // 1. Upscale the field onto the opaque layer. The smooth resample plus
      //    the blur is the `soften` pass; overdraw keeps the blur from pulling
      //    transparency in at the borders.
      layerCtx.globalCompositeOperation = "source-over";
      layerCtx.globalAlpha = 1;
      layerCtx.filter = SOFTEN > 0 ? `blur(${SOFTEN}px)` : "none";
      layerCtx.imageSmoothingEnabled = true;
      layerCtx.imageSmoothingQuality = "high";
      layerCtx.drawImage(
        buffer,
        -SOFTEN * 2,
        -SOFTEN * 2,
        width + SOFTEN * 4,
        height + SOFTEN * 4,
      );
      layerCtx.filter = "none";

      // 2. Grain, while the layer is still fully opaque so `overlay` is correct.
      if (grain && GRAIN > 0) {
        layerCtx.globalCompositeOperation = "overlay";
        layerCtx.globalAlpha = GRAIN / 200;
        layerCtx.fillStyle = grain;
        layerCtx.fillRect(0, 0, width, height);
        layerCtx.globalAlpha = 1;
      }

      // 3. Feather all four edges. Two `destination-in` passes multiply, so the
      //    corners fall off on both axes.
      layerCtx.globalCompositeOperation = "destination-in";

      const vertical = layerCtx.createLinearGradient(0, 0, 0, height);
      vertical.addColorStop(0, "rgba(0,0,0,0)");
      vertical.addColorStop(FADE_Y, "rgba(0,0,0,1)");
      vertical.addColorStop(1 - FADE_Y, "rgba(0,0,0,1)");
      vertical.addColorStop(1, "rgba(0,0,0,0)");
      layerCtx.fillStyle = vertical;
      layerCtx.fillRect(0, 0, width, height);

      const horizontal = layerCtx.createLinearGradient(0, 0, width, 0);
      horizontal.addColorStop(0, "rgba(0,0,0,0)");
      horizontal.addColorStop(FADE_X, "rgba(0,0,0,1)");
      horizontal.addColorStop(1 - FADE_X, "rgba(0,0,0,1)");
      horizontal.addColorStop(1, "rgba(0,0,0,0)");
      layerCtx.fillStyle = horizontal;
      layerCtx.fillRect(0, 0, width, height);

      layerCtx.globalCompositeOperation = "source-over";

      // 4. Present.
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(layer, 0, 0, width, height);
    };

    let frame = 0;
    let start = 0;

    const loop = (now: number) => {
      if (!start) start = now;
      draw(((now - start) / 1000) * (SPEED / 100));
      frame = requestAnimationFrame(loop);
    };

    resize();

    if (reduceMotion) {
      draw(0);
    } else {
      frame = requestAnimationFrame(loop);
    }

    const observer = new ResizeObserver(() => {
      resize();
      if (reduceMotion) draw(0);
    });
    observer.observe(canvas);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className={className} />;
}
