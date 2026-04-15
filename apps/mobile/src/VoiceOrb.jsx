import { useEffect, useMemo, useRef } from "react";

const TAU = Math.PI * 2;
const MIN_CANVAS_SIZE = 260;
const DEFAULT_HISTORY = Array.from({ length: 24 }, () => 0.08);
const DEFAULT_RGB = { r: 255, g: 255, b: 255 };

const DEFAULT_PALETTE = [
  {
    color: "#71f7ff",
    glowColor: "rgba(113, 247, 255, 0.72)",
    electronColor: "rgba(236, 253, 255, 0.98)"
  },
  {
    color: "#34ddff",
    glowColor: "rgba(52, 221, 255, 0.64)",
    electronColor: "rgba(229, 250, 255, 0.96)"
  },
  {
    color: "#ff5cee",
    glowColor: "rgba(255, 92, 238, 0.58)",
    electronColor: "rgba(255, 235, 251, 0.96)"
  },
  {
    color: "#ff39c8",
    glowColor: "rgba(255, 57, 200, 0.5)",
    electronColor: "rgba(255, 230, 246, 0.92)"
  }
];

const ERROR_PALETTE = [
  {
    color: "#ff9ab1",
    glowColor: "rgba(255, 154, 177, 0.7)",
    electronColor: "rgba(255, 241, 245, 0.98)"
  },
  {
    color: "#ffa569",
    glowColor: "rgba(255, 165, 105, 0.56)",
    electronColor: "rgba(255, 243, 233, 0.96)"
  },
  {
    color: "#ffd86f",
    glowColor: "rgba(255, 216, 111, 0.48)",
    electronColor: "rgba(255, 249, 232, 0.94)"
  }
];

const DEFAULT_VISUAL_CONFIG = Object.freeze({
  orbitCount: 5,
  nucleusScale: 1.04,
  motionScale: 1,
  palette: DEFAULT_PALETTE,
  errorPalette: ERROR_PALETTE
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) {
    return value < edge0 ? 0 : 1;
  }

  const progress = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return progress * progress * (3 - 2 * progress);
}

function mixNumber(a, b, amount) {
  return a + (b - a) * amount;
}

function easeToward(current, target, deltaSeconds, risePerSecond, fallPerSecond) {
  const safeDelta = clamp(Number(deltaSeconds) || 0, 1 / 240, 0.08);
  const rate = target > current ? risePerSecond : fallPerSecond;
  const amount = 1 - Math.exp(-Math.max(0.01, rate) * safeDelta);
  return current + (target - current) * amount;
}

function normalizeNumber(value, fallback, min, max) {
  const next = Number(value);

  if (!Number.isFinite(next)) {
    return fallback;
  }

  return clamp(next, min, max);
}

function resolveHistory(levelHistory) {
  if (!Array.isArray(levelHistory) || levelHistory.length === 0) {
    return DEFAULT_HISTORY;
  }

  return levelHistory.map((value) => clamp(Number(value) || 0, 0, 1));
}

function withAlpha(color, alpha) {
  const normalized = String(color).trim();
  const rgbMatch = normalized.match(/rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*[0-9.]+)?\s*\)/i);

  if (rgbMatch) {
    return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
  }

  const hexMatch = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);

  if (!hexMatch) {
    return color;
  }

  const hex = hexMatch[1];
  const step = hex.length === 3 ? 1 : 2;
  const channels = [];

  for (let index = 0; index < hex.length; index += step) {
    const segment = hex.slice(index, index + step);
    const value = step === 1 ? `${segment}${segment}` : segment;
    channels.push(Number.parseInt(value, 16));
  }

  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
}

function parseColor(color, fallback = DEFAULT_RGB) {
  const normalized = typeof color === "string" ? color.trim() : "";
  const rgbMatch = normalized.match(/rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*[0-9.]+)?\s*\)/i);

  if (rgbMatch) {
    return {
      r: clamp(Math.round(Number(rgbMatch[1]) || fallback.r), 0, 255),
      g: clamp(Math.round(Number(rgbMatch[2]) || fallback.g), 0, 255),
      b: clamp(Math.round(Number(rgbMatch[3]) || fallback.b), 0, 255)
    };
  }

  const hexMatch = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);

  if (!hexMatch) {
    return fallback;
  }

  const hex = hexMatch[1];

  if (hex.length === 3) {
    return {
      r: Number.parseInt(`${hex[0]}${hex[0]}`, 16),
      g: Number.parseInt(`${hex[1]}${hex[1]}`, 16),
      b: Number.parseInt(`${hex[2]}${hex[2]}`, 16)
    };
  }

  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16)
  };
}

function normalizePaletteEntry(entry, fallbackEntry) {
  const fallback = fallbackEntry ?? DEFAULT_PALETTE[0];
  const source = entry && typeof entry === "object" ? entry : {};

  return {
    color: typeof source.color === "string" && source.color.trim() ? source.color : fallback.color,
    glowColor: typeof source.glowColor === "string" && source.glowColor.trim() ? source.glowColor : fallback.glowColor,
    electronColor:
      typeof source.electronColor === "string" && source.electronColor.trim() ? source.electronColor : fallback.electronColor
  };
}

function resolvePalette(entries, count, fallbackEntries) {
  const fallback = Array.isArray(fallbackEntries) && fallbackEntries.length > 0 ? fallbackEntries : DEFAULT_PALETTE;
  const source = Array.isArray(entries) && entries.length > 0 ? entries : fallback;

  return Array.from({ length: count }, (_, index) => normalizePaletteEntry(source[index % source.length], fallback[index % fallback.length]));
}

function resolveVisualConfig(visualConfig) {
  const source = visualConfig && typeof visualConfig === "object" ? visualConfig : {};
  const fluidBlobCount = Math.round(normalizeNumber(source.fluidBlobCount ?? source.orbitCount, DEFAULT_VISUAL_CONFIG.orbitCount, 4, 8));

  return {
    fluidBlobCount,
    nucleusScale: normalizeNumber(source.nucleusScale, DEFAULT_VISUAL_CONFIG.nucleusScale, 0.84, 1.32),
    motionScale: normalizeNumber(source.motionScale ?? source.electronSpeedScale, DEFAULT_VISUAL_CONFIG.motionScale, 0.82, 1.48),
    palette: resolvePalette(source.palette, fluidBlobCount, DEFAULT_VISUAL_CONFIG.palette),
    errorPalette: resolvePalette(source.errorPalette, fluidBlobCount, DEFAULT_VISUAL_CONFIG.errorPalette)
  };
}

function createFluidModels(blobCount) {
  return Array.from({ length: blobCount }, (_, index) => {
    if (index === 0) {
      return {
        radius: 0.42,
        orbitX: 0.05,
        orbitY: 0.04,
        verticalBias: -0.03,
        speed: 0.7,
        yFrequency: 0.88,
        phase: 0.18,
        stretch: 1.22,
        density: 1.2,
        drift: 0.04,
        swirl: 1.1
      };
    }

    const satelliteIndex = index - 1;
    const side = satelliteIndex % 2 === 0 ? 1 : -1;
    const layer = Math.floor(satelliteIndex / 2);

    return {
      radius: 0.23 - layer * 0.012 + (satelliteIndex % 3) * 0.006,
      orbitX: 0.18 + layer * 0.05,
      orbitY: 0.12 + layer * 0.034,
      verticalBias: side * (0.06 + layer * 0.022),
      speed: 0.76 + satelliteIndex * 0.08,
      yFrequency: 0.94 + (satelliteIndex % 3) * 0.07,
      phase: satelliteIndex * 1.19 + side * 0.42,
      stretch: 0.96 + layer * 0.05,
      density: 0.82 - layer * 0.04,
      drift: 0.09 + layer * 0.018,
      swirl: 0.84 + satelliteIndex * 0.08
    };
  });
}

function ensureFluidBuffer(bufferRef, resolution) {
  const nextResolution = Math.max(96, Math.round(resolution));
  const current = bufferRef.current;

  if (current.canvas && current.resolution === nextResolution) {
    return current;
  }

  const canvas = document.createElement("canvas");
  canvas.width = nextResolution;
  canvas.height = nextResolution;

  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  const buffer = {
    canvas,
    context,
    imageData: context.createImageData(nextResolution, nextResolution),
    resolution: nextResolution
  };

  bufferRef.current = buffer;
  return buffer;
}

function buildFluidBlobFrame(models, time, energy, motionScale) {
  return models.map((model, index) => {
    const drive = time * model.speed * motionScale * (0.64 + energy * 0.42) + model.phase;
    const driftX = Math.sin(time * 0.31 + model.phase * 1.3) * model.drift * 0.58;
    const driftY = Math.cos(time * 0.27 + model.phase * 0.9) * model.drift * 0.42;
    const orbitX = model.orbitX * (1 + Math.sin(drive * 0.33 + index) * 0.06);
    const orbitY = model.orbitY * (1 + Math.cos(drive * 0.28 - index * 0.4) * 0.05);

    return {
      x: Math.cos(drive) * orbitX + Math.sin(drive * 0.42 + model.phase) * 0.028 + driftX,
      y:
        Math.sin(drive * model.yFrequency) * orbitY +
        Math.cos(drive * 0.51 - model.phase) * 0.026 +
        driftY +
        model.verticalBias * (0.34 + energy * 0.22),
      radius: model.radius * (1 + Math.sin(drive * 0.82 + model.phase) * 0.08 + energy * 0.08),
      stretchX: 1 + Math.sin(drive * 0.58) * 0.14,
      stretchY: model.stretch + Math.cos(drive * 0.64) * 0.11,
      density: model.density,
      swirl: model.swirl,
      phase: model.phase
    };
  });
}

function drawAtmosphere(context, width, height, cx, cy, radius, palette, energy) {
  const cyan = palette[0] ?? DEFAULT_PALETTE[0];
  const magenta = palette[Math.max(0, palette.length - 1)] ?? DEFAULT_PALETTE[2];

  const base = context.createRadialGradient(cx, cy, radius * 0.2, cx, cy, Math.max(width, height) * 0.88);
  base.addColorStop(0, "rgba(10, 12, 24, 0.02)");
  base.addColorStop(0.34, withAlpha(cyan.glowColor, 0.12 + energy * 0.06));
  base.addColorStop(0.68, withAlpha(magenta.glowColor, 0.08 + energy * 0.04));
  base.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = base;
  context.fillRect(0, 0, width, height);

  const leftGlow = context.createRadialGradient(cx - radius * 0.66, cy - radius * 0.14, 0, cx - radius * 0.66, cy - radius * 0.14, radius * 1.3);
  leftGlow.addColorStop(0, withAlpha(cyan.color, 0.28 + energy * 0.08));
  leftGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = leftGlow;
  context.fillRect(0, 0, width, height);

  const rightGlow = context.createRadialGradient(cx + radius * 0.62, cy + radius * 0.18, 0, cx + radius * 0.62, cy + radius * 0.18, radius * 1.22);
  rightGlow.addColorStop(0, withAlpha(magenta.color, 0.24 + energy * 0.08));
  rightGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = rightGlow;
  context.fillRect(0, 0, width, height);
}

function drawOuterShell(context, cx, cy, radius, palette, energy) {
  const cyan = palette[0] ?? DEFAULT_PALETTE[0];
  const magenta = palette[Math.max(0, palette.length - 1)] ?? DEFAULT_PALETTE[2];

  context.save();
  context.beginPath();
  context.arc(cx, cy, radius * 1.08, 0, TAU);
  const shell = context.createRadialGradient(cx - radius * 0.24, cy - radius * 0.3, radius * 0.12, cx, cy, radius * 1.18);
  shell.addColorStop(0, "rgba(255, 255, 255, 0.18)");
  shell.addColorStop(0.1, "rgba(95, 108, 145, 0.16)");
  shell.addColorStop(0.58, "rgba(11, 17, 36, 0.74)");
  shell.addColorStop(1, "rgba(2, 5, 12, 0.98)");
  context.fillStyle = shell;
  context.fill();
  context.restore();

  context.save();
  context.lineWidth = radius * 0.055;
  context.strokeStyle = "rgba(7, 13, 28, 0.88)";
  context.shadowColor = withAlpha(cyan.color, 0.14 + energy * 0.04);
  context.shadowBlur = radius * 0.22;
  context.beginPath();
  context.arc(cx, cy, radius * 1.04, 0, TAU);
  context.stroke();
  context.restore();

  const rim = context.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
  rim.addColorStop(0, withAlpha(cyan.electronColor, 0.42));
  rim.addColorStop(0.42, withAlpha(cyan.color, 0.14));
  rim.addColorStop(0.58, withAlpha(magenta.color, 0.16));
  rim.addColorStop(1, withAlpha(magenta.electronColor, 0.46));

  context.save();
  context.lineWidth = radius * 0.018;
  context.strokeStyle = rim;
  context.shadowColor = withAlpha(cyan.color, 0.26);
  context.shadowBlur = radius * 0.08;
  context.beginPath();
  context.arc(cx, cy, radius * 0.965, 0, TAU);
  context.stroke();
  context.restore();
}

function drawInnerGlass(context, cx, cy, radius, palette, energy) {
  const cyan = palette[0] ?? DEFAULT_PALETTE[0];
  const magenta = palette[Math.max(0, palette.length - 1)] ?? DEFAULT_PALETTE[2];
  const interior = context.createRadialGradient(cx - radius * 0.3, cy - radius * 0.34, radius * 0.1, cx, cy, radius);
  interior.addColorStop(0, "rgba(55, 62, 97, 0.3)");
  interior.addColorStop(0.2, "rgba(27, 25, 56, 0.42)");
  interior.addColorStop(0.6, "rgba(9, 12, 27, 0.9)");
  interior.addColorStop(1, "rgba(4, 7, 18, 0.98)");
  context.fillStyle = interior;
  context.beginPath();
  context.arc(cx, cy, radius * 0.93, 0, TAU);
  context.fill();

  const sheen = context.createRadialGradient(cx - radius * 0.36, cy - radius * 0.42, 0, cx - radius * 0.36, cy - radius * 0.42, radius * 0.72);
  sheen.addColorStop(0, "rgba(255, 255, 255, 0.34)");
  sheen.addColorStop(0.36, withAlpha(cyan.electronColor, 0.12));
  sheen.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = sheen;
  context.beginPath();
  context.arc(cx, cy, radius * 0.92, 0, TAU);
  context.fill();

  const bloom = context.createRadialGradient(cx + radius * 0.18, cy + radius * 0.1, radius * 0.08, cx + radius * 0.18, cy + radius * 0.1, radius * (0.88 + energy * 0.1));
  bloom.addColorStop(0, withAlpha(magenta.color, 0.12 + energy * 0.05));
  bloom.addColorStop(0.52, withAlpha(cyan.color, 0.08 + energy * 0.03));
  bloom.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = bloom;
  context.beginPath();
  context.arc(cx, cy, radius * 0.92, 0, TAU);
  context.fill();
}

function renderFluidLayer(buffer, palette, energy, time, blobFrame, nucleusScale) {
  const { canvas, context, imageData, resolution } = buffer;
  const pixels = imageData.data;
  const top = parseColor(palette[0]?.electronColor ?? DEFAULT_PALETTE[0].electronColor, DEFAULT_RGB);
  const mid = parseColor(palette[Math.floor(palette.length / 2)]?.color ?? DEFAULT_PALETTE[1].color, DEFAULT_RGB);
  const bottom = parseColor(palette[Math.max(0, palette.length - 1)]?.color ?? DEFAULT_PALETTE[2].color, DEFAULT_RGB);
  const glow = parseColor(palette[0]?.glowColor ?? DEFAULT_PALETTE[0].glowColor, DEFAULT_RGB);
  const rim = parseColor(palette[Math.max(0, palette.length - 1)]?.electronColor ?? DEFAULT_PALETTE[2].electronColor, DEFAULT_RGB);
  const threshold = 1.08 - energy * 0.08;
  const centerNucleus = 0.14 * nucleusScale * (1 + energy * 0.16);
  const invSize = 1 / Math.max(1, resolution - 1);
  let pixelIndex = 0;

  for (let y = 0; y < resolution; y += 1) {
    const ny = y * invSize * 2 - 1;

    for (let x = 0; x < resolution; x += 1) {
      const nx = x * invSize * 2 - 1;
      const radialSquared = nx * nx + ny * ny;

      if (radialSquared > 1.03) {
        pixels[pixelIndex] = 0;
        pixels[pixelIndex + 1] = 0;
        pixels[pixelIndex + 2] = 0;
        pixels[pixelIndex + 3] = 0;
        pixelIndex += 4;
        continue;
      }

      let field = 0;
      let swirl = 0;
      let pressure = 0;

      for (let index = 0; index < blobFrame.length; index += 1) {
        const blob = blobFrame[index];
        const dx = (nx - blob.x) / blob.stretchX;
        const dy = (ny - blob.y) / blob.stretchY;
        const distanceSquared = dx * dx + dy * dy + 0.0028;
        const influence = (blob.radius * blob.radius * blob.density) / distanceSquared;
        field += influence;
        swirl += influence * Math.sin(blob.phase + nx * (4.2 + blob.swirl) - ny * (3.8 + blob.swirl * 0.6));
        pressure += influence * Math.cos(blob.phase * 0.72 + radialSquared * 4.4);
      }

      field += Math.max(0, 1 - radialSquared) * (0.28 + energy * 0.12);
      const alpha = smoothstep(threshold - 0.16, threshold + 0.42, field);

      if (alpha < 0.015) {
        pixels[pixelIndex] = 0;
        pixels[pixelIndex + 1] = 0;
        pixels[pixelIndex + 2] = 0;
        pixels[pixelIndex + 3] = 0;
        pixelIndex += 4;
        continue;
      }

      const edgeBand =
        smoothstep(threshold - 0.04, threshold + 0.08, field) - smoothstep(threshold + 0.16, threshold + 0.42, field);
      const verticalMix = smoothstep(-0.9, 0.92, ny + pressure * 0.012);
      const topToMid = smoothstep(0, 0.62, verticalMix);
      const midToBottom = smoothstep(0.24, 1, verticalMix);
      let red = mixNumber(top.r, mid.r, topToMid);
      let green = mixNumber(top.g, mid.g, topToMid);
      let blue = mixNumber(top.b, mid.b, topToMid);
      red = mixNumber(red, bottom.r, midToBottom * 0.84);
      green = mixNumber(green, bottom.g, midToBottom * 0.84);
      blue = mixNumber(blue, bottom.b, midToBottom * 0.84);

      const highlight = Math.pow(clamp(1 - Math.hypot(nx + 0.24, ny + 0.36) / 1.18, 0, 1), 2.2) * (0.46 + energy * 0.34);
      const liquidCaustic =
        (Math.sin(nx * 8.6 - time * 2.1 + swirl * 0.18) + Math.cos(ny * 12.4 + time * 1.6 - pressure * 0.22)) * 0.5;
      const causticAlpha = (liquidCaustic * 0.5 + 0.5) * alpha * (0.1 + energy * 0.08);
      const nucleusDistance = Math.hypot(nx * 0.92, ny * 0.92);
      const nucleusGlow = Math.pow(clamp(1 - nucleusDistance / (centerNucleus * 4.8), 0, 1), 2.1) * (0.24 + energy * 0.22);
      const edgeGlow = edgeBand * (0.46 + energy * 0.12);
      const interiorShadow = Math.pow(clamp(radialSquared, 0, 1), 1.6) * 0.18;

      red = red * (0.88 - interiorShadow) + glow.r * causticAlpha * 0.2 + 255 * highlight * 0.28 + rim.r * edgeGlow * 0.34 + top.r * nucleusGlow * 0.14;
      green = green * (0.9 - interiorShadow * 0.9) + glow.g * causticAlpha * 0.28 + 255 * highlight * 0.34 + rim.g * edgeGlow * 0.38 + top.g * nucleusGlow * 0.16;
      blue = blue * (0.94 - interiorShadow * 0.76) + glow.b * causticAlpha * 0.38 + 255 * highlight * 0.38 + rim.b * edgeGlow * 0.34 + top.b * nucleusGlow * 0.2;

      const sphereFade = 1 - smoothstep(0.8, 1, radialSquared);
      const finalAlpha = clamp(alpha * (0.86 + edgeGlow * 0.26 + nucleusGlow * 0.08) * (0.42 + sphereFade * 0.58), 0, 1);

      pixels[pixelIndex] = clamp(Math.round(red), 0, 255);
      pixels[pixelIndex + 1] = clamp(Math.round(green), 0, 255);
      pixels[pixelIndex + 2] = clamp(Math.round(blue), 0, 255);
      pixels[pixelIndex + 3] = clamp(Math.round(finalAlpha * 255), 0, 255);
      pixelIndex += 4;
    }
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

function drawFluidCore(context, cx, cy, radius, palette, energy, time, nucleusScale) {
  const cyan = palette[0] ?? DEFAULT_PALETTE[0];
  const magenta = palette[Math.max(0, palette.length - 1)] ?? DEFAULT_PALETTE[2];
  const coreRadius = radius * 0.18 * nucleusScale * (1 + energy * 0.08);

  const glow = context.createRadialGradient(cx, cy, coreRadius * 0.1, cx, cy, coreRadius * 3.3);
  glow.addColorStop(0, "rgba(255, 255, 255, 0.56)");
  glow.addColorStop(0.18, withAlpha(cyan.electronColor, 0.22 + energy * 0.06));
  glow.addColorStop(0.54, withAlpha(magenta.color, 0.14 + energy * 0.04));
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = glow;
  context.beginPath();
  context.arc(cx, cy, coreRadius * 2.8, 0, TAU);
  context.fill();

  const core = context.createRadialGradient(cx - coreRadius * 0.2, cy - coreRadius * 0.24, coreRadius * 0.06, cx, cy, coreRadius);
  core.addColorStop(0, "rgba(255, 255, 255, 0.98)");
  core.addColorStop(0.48, withAlpha(cyan.color, 0.86));
  core.addColorStop(1, withAlpha(magenta.color, 0.38));
  context.fillStyle = core;
  context.beginPath();
  context.arc(cx, cy, coreRadius, 0, TAU);
  context.fill();

  for (let index = 0; index < 7; index += 1) {
    const angle = time * (0.56 + index * 0.06) + index * 0.92;
    const particleRadius = coreRadius * (0.06 + (index % 3) * 0.018) * (1 + energy * 0.08);
    const particleX = cx + Math.cos(angle) * coreRadius * (0.62 + (index % 2) * 0.14);
    const particleY = cy + Math.sin(angle * 1.22) * coreRadius * (0.56 + (index % 3) * 0.08);

    context.save();
    context.fillStyle = index % 2 === 0 ? withAlpha(cyan.electronColor, 0.48) : withAlpha(magenta.electronColor, 0.42);
    context.shadowColor = index % 2 === 0 ? cyan.color : magenta.color;
    context.shadowBlur = coreRadius * 0.4;
    context.globalAlpha = 0.7;
    context.beginPath();
    context.arc(particleX, particleY, particleRadius, 0, TAU);
    context.fill();
    context.restore();
  }
}

function drawSuspendedDroplets(context, cx, cy, radius, palette, energy, time) {
  const cyan = palette[0] ?? DEFAULT_PALETTE[0];
  const magenta = palette[Math.max(0, palette.length - 1)] ?? DEFAULT_PALETTE[2];

  for (let index = 0; index < 18; index += 1) {
    const angle = time * 0.22 + index * 1.38;
    const drift = radius * (0.16 + ((index * 5) % 9) * 0.045);
    const x = cx + Math.cos(angle * 1.18 + index * 0.34) * drift;
    const y = cy + Math.sin(angle * 0.92 - index * 0.21) * drift * 0.82;
    const size = radius * (0.005 + (index % 4) * 0.0014);

    context.save();
    context.fillStyle = index % 2 === 0 ? withAlpha(cyan.electronColor, 0.26) : withAlpha(magenta.electronColor, 0.24);
    context.globalAlpha = 0.2 + energy * 0.14;
    context.beginPath();
    context.arc(x, y, size, 0, TAU);
    context.fill();
    context.restore();
  }
}

function drawSurfaceCaustics(context, cx, cy, radius, palette, energy, time) {
  const cyan = palette[0] ?? DEFAULT_PALETTE[0];
  const magenta = palette[Math.max(0, palette.length - 1)] ?? DEFAULT_PALETTE[2];

  for (let index = 0; index < 3; index += 1) {
    const progress = index / 2;
    const y = cy - radius * (0.18 - progress * 0.2) + Math.sin(time * (0.7 + index * 0.14) + index * 1.8) * radius * 0.032;
    const span = radius * (0.84 - progress * 0.1);

    context.save();
    context.beginPath();
    context.moveTo(cx - span * 0.58, y);
    context.bezierCurveTo(
      cx - span * 0.28,
      y - radius * (0.08 + progress * 0.04),
      cx + span * 0.1,
      y + radius * (0.12 - progress * 0.03),
      cx + span * 0.52,
      y - radius * (0.02 + progress * 0.02)
    );
    context.lineCap = "round";
    context.lineWidth = radius * (0.012 - progress * 0.002);
    context.strokeStyle = index === 1 ? withAlpha(magenta.electronColor, 0.16 + energy * 0.04) : withAlpha(cyan.electronColor, 0.16 + energy * 0.05);
    context.shadowColor = index === 1 ? withAlpha(magenta.color, 0.18 + energy * 0.05) : withAlpha(cyan.color, 0.2 + energy * 0.05);
    context.shadowBlur = radius * 0.08;
    context.globalAlpha = 0.74;
    context.stroke();
    context.restore();
  }
}

function drawSpecularHighlights(context, cx, cy, radius, palette, energy) {
  const cyan = palette[0] ?? DEFAULT_PALETTE[0];

  context.save();
  const arcGradient = context.createLinearGradient(cx - radius * 0.68, cy - radius * 0.82, cx + radius * 0.12, cy - radius * 0.14);
  arcGradient.addColorStop(0, "rgba(255, 255, 255, 0)");
  arcGradient.addColorStop(0.35, withAlpha(cyan.electronColor, 0.3 + energy * 0.06));
  arcGradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  context.strokeStyle = arcGradient;
  context.lineCap = "round";
  context.lineWidth = radius * 0.024;
  context.beginPath();
  context.arc(cx - radius * 0.04, cy - radius * 0.04, radius * 0.74, Math.PI * 1.03, Math.PI * 1.52);
  context.stroke();
  context.restore();

  context.save();
  const spot = context.createRadialGradient(cx - radius * 0.38, cy - radius * 0.46, 0, cx - radius * 0.38, cy - radius * 0.46, radius * 0.22);
  spot.addColorStop(0, "rgba(255, 255, 255, 0.34)");
  spot.addColorStop(0.42, withAlpha(cyan.electronColor, 0.16));
  spot.addColorStop(1, "rgba(255, 255, 255, 0)");
  context.fillStyle = spot;
  context.beginPath();
  context.arc(cx - radius * 0.38, cy - radius * 0.46, radius * 0.22, 0, TAU);
  context.fill();
  context.restore();
}

export default function VoiceOrb({
  audioMetricsRef = null,
  isListening = false,
  isResponding = false,
  connectionState = "idle",
  visualConfig = null
}) {
  const canvasRef = useRef(null);
  const fluidBufferRef = useRef({ canvas: null, context: null, imageData: null, resolution: 0 });
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
  const drawStateRef = useRef({
    inputAudioLevel: Number(audioMetricsRef?.current?.inputAudioLevel) || 0,
    outputAudioLevel: Number(audioMetricsRef?.current?.outputAudioLevel) || 0,
    audioLevel: Number(audioMetricsRef?.current?.audioLevel) || 0,
    levelHistory: Array.isArray(audioMetricsRef?.current?.levelHistory) ? audioMetricsRef.current.levelHistory : [],
    isListening,
    isResponding,
    connectionState
  });
  const smoothedInputLevelRef = useRef(0);
  const smoothedOutputLevelRef = useRef(0);
  const smoothedCombinedLevelRef = useRef(0);
  const motionEnergyRef = useRef(0.12);
  const motionTimeRef = useRef(0);
  const lastFrameTimeRef = useRef(0);

  const resolvedVisualConfig = useMemo(() => resolveVisualConfig(visualConfig), [visualConfig]);
  const fluidModels = useMemo(() => createFluidModels(resolvedVisualConfig.fluidBlobCount), [resolvedVisualConfig.fluidBlobCount]);

  useEffect(() => {
    const nextAudioMetrics = audioMetricsRef?.current;

    drawStateRef.current = {
      inputAudioLevel: Number(nextAudioMetrics?.inputAudioLevel) || 0,
      outputAudioLevel: Number(nextAudioMetrics?.outputAudioLevel) || 0,
      audioLevel: Number(nextAudioMetrics?.audioLevel) || 0,
      levelHistory: Array.isArray(nextAudioMetrics?.levelHistory) ? nextAudioMetrics.levelHistory : [],
      isListening,
      isResponding,
      connectionState
    };
  }, [audioMetricsRef, connectionState, isListening, isResponding]);

  useEffect(() => {
    let raf = 0;
    const canvas = canvasRef.current;

    if (!canvas) {
      return undefined;
    }

    const context = canvas.getContext("2d");

    if (!context) {
      return undefined;
    }

    const draw = () => {
      const host = canvas.parentElement;
      const nextWidth = Math.max(MIN_CANVAS_SIZE, Math.floor(host?.clientWidth || canvas.clientWidth || 0));
      const nextHeight = Math.max(MIN_CANVAS_SIZE, Math.floor(host?.clientHeight || canvas.clientHeight || 0));
      const nextDpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const previous = sizeRef.current;

      if (previous.width !== nextWidth || previous.height !== nextHeight || previous.dpr !== nextDpr) {
        canvas.width = nextWidth * nextDpr;
        canvas.height = nextHeight * nextDpr;
        canvas.style.width = `${nextWidth}px`;
        canvas.style.height = `${nextHeight}px`;
        context.setTransform(nextDpr, 0, 0, nextDpr, 0, 0);
        sizeRef.current = { width: nextWidth, height: nextHeight, dpr: nextDpr };
      }

      const width = sizeRef.current.width;
      const height = sizeRef.current.height;
      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.min(width, height) * 0.31;
      const now = performance.now();
      const previousFrameTime = lastFrameTimeRef.current || now;
      const deltaSeconds = clamp((now - previousFrameTime) / 1000, 1 / 120, 1 / 24);
      lastFrameTimeRef.current = now;
      const liveAudioMetrics = audioMetricsRef?.current;
      const state = {
        ...drawStateRef.current,
        inputAudioLevel: Number(liveAudioMetrics?.inputAudioLevel ?? drawStateRef.current.inputAudioLevel) || 0,
        outputAudioLevel: Number(liveAudioMetrics?.outputAudioLevel ?? drawStateRef.current.outputAudioLevel) || 0,
        audioLevel: Number(liveAudioMetrics?.audioLevel ?? drawStateRef.current.audioLevel) || 0,
        levelHistory: Array.isArray(liveAudioMetrics?.levelHistory) ? liveAudioMetrics.levelHistory : drawStateRef.current.levelHistory
      };
      const history = resolveHistory(state.levelHistory);
      const historyAverage = history.reduce((sum, entry) => sum + entry, 0) / history.length;
      const historyPeak = history.reduce((maxValue, entry) => Math.max(maxValue, entry), 0);
      const inputLevel = clamp(Number(state.inputAudioLevel ?? state.audioLevel) || 0, 0, 1);
      const outputLevel = clamp(Number(state.outputAudioLevel ?? state.audioLevel) || 0, 0, 1);
      const smoothedInput = easeToward(smoothedInputLevelRef.current, inputLevel, deltaSeconds, 9.5, 4.2);
      const smoothedOutput = easeToward(smoothedOutputLevelRef.current, outputLevel, deltaSeconds, 10.5, 4.8);
      const combinedTarget = clamp(
        Math.max(smoothedInput * 0.88, smoothedOutput * 1.02, smoothedInput * 0.38 + smoothedOutput * 0.8, Number(state.audioLevel) || 0),
        0,
        1
      );
      const smoothedCombined = easeToward(smoothedCombinedLevelRef.current, combinedTarget, deltaSeconds, 8.2, 3.8);
      const baseActivity = (state.isResponding ? 0.05 : 0) + (state.isListening ? 0.03 : 0);
      const targetEnergy = clamp(0.12 + smoothedCombined * 0.68 + historyAverage * 0.18 + historyPeak * 0.08 + baseActivity, 0.12, 0.98);
      const energy = easeToward(motionEnergyRef.current, targetEnergy, deltaSeconds, 5.6, 2.4);
      const activePalette = state.connectionState === "error" ? resolvedVisualConfig.errorPalette : resolvedVisualConfig.palette;
      const motionScale =
        resolvedVisualConfig.motionScale *
        mixNumber(0.72, 1.02, energy) *
        mixNumber(0.94, 1.08, clamp(smoothedOutput * 0.7 + smoothedInput * 0.3, 0, 1));
      const ambientAdvance = 0.18 + resolvedVisualConfig.motionScale * 0.08;
      const reactiveAdvance = 0.16 + energy * 0.28 + smoothedOutput * 0.18 + smoothedInput * 0.1;
      motionTimeRef.current += deltaSeconds * (ambientAdvance + reactiveAdvance);
      const time = motionTimeRef.current;
      const fluidResolution = clamp(Math.round(radius * 0.92), 128, 196);
      const fluidBuffer = ensureFluidBuffer(fluidBufferRef, fluidResolution);
      const blobFrame = buildFluidBlobFrame(fluidModels, time, energy, motionScale);

      smoothedInputLevelRef.current = smoothedInput;
      smoothedOutputLevelRef.current = smoothedOutput;
      smoothedCombinedLevelRef.current = smoothedCombined;
      motionEnergyRef.current = energy;
      context.clearRect(0, 0, width, height);
      drawAtmosphere(context, width, height, cx, cy, radius, activePalette, energy);
      drawOuterShell(context, cx, cy, radius, activePalette, energy);

      context.save();
      context.beginPath();
      context.arc(cx, cy, radius * 0.93, 0, TAU);
      context.clip();

      drawInnerGlass(context, cx, cy, radius, activePalette, energy);

      if (fluidBuffer) {
        const fluidCanvas = renderFluidLayer(fluidBuffer, activePalette, energy, time, blobFrame, resolvedVisualConfig.nucleusScale);
        const fluidSize = radius * 1.7;
        const fluidX = cx - fluidSize / 2;
        const fluidY = cy - fluidSize / 2;

        context.save();
        context.globalCompositeOperation = "screen";
        context.globalAlpha = 0.38 + energy * 0.18;
        context.filter = `blur(${radius * 0.085}px)`;
        context.drawImage(fluidCanvas, fluidX, fluidY, fluidSize, fluidSize);
        context.restore();

        context.save();
        context.globalCompositeOperation = "screen";
        context.globalAlpha = 0.94;
        context.drawImage(fluidCanvas, fluidX, fluidY, fluidSize, fluidSize);
        context.restore();
      }

      drawSurfaceCaustics(context, cx, cy, radius, activePalette, energy, time);
      drawFluidCore(context, cx, cy, radius, activePalette, energy, time, resolvedVisualConfig.nucleusScale);
      drawSuspendedDroplets(context, cx, cy, radius, activePalette, energy, time);
      drawSpecularHighlights(context, cx, cy, radius, activePalette, energy);
      context.restore();

      raf = window.requestAnimationFrame(draw);
    };

    raf = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [audioMetricsRef, fluidModels, resolvedVisualConfig]);

  return <canvas ref={canvasRef} className="voice-mode-panel__orb-canvas" aria-hidden="true" />;
}
