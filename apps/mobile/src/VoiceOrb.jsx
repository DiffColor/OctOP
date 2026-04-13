import { useEffect, useMemo, useRef } from "react";

const TAU = Math.PI * 2;
const MIN_CANVAS_SIZE = 220;
const BASE_CAMERA_DISTANCE = 410;
const DEFAULT_HISTORY = Array.from({ length: 24 }, () => 0.08);

const BASE_ORBIT_SHAPES = [
  {
    radiusFactor: 0.64,
    tiltX: -0.94,
    tiltY: 0.34,
    tiltZ: 0.18,
    tiltDriftX: 0.11,
    tiltDriftY: 0.08,
    tiltDriftZ: 0.05,
    precessionX: 0.22,
    precessionY: 0.76,
    precessionZ: 0.16,
    electronSpeed: 1.42,
    direction: 1,
    phase: 0.16,
    distortion: 0.028,
    breatheSpeed: 0.44,
    breatheAmount: 0.018,
    electronSize: 0.92,
    lineWidth: 0.98
  },
  {
    radiusFactor: 0.82,
    tiltX: 0.78,
    tiltY: -1.02,
    tiltZ: -0.22,
    tiltDriftX: 0.12,
    tiltDriftY: 0.1,
    tiltDriftZ: 0.06,
    precessionX: 0.28,
    precessionY: 0.58,
    precessionZ: -0.2,
    electronSpeed: 1.64,
    direction: -1,
    phase: 1.18,
    distortion: 0.03,
    breatheSpeed: 0.38,
    breatheAmount: 0.02,
    electronSize: 1.02,
    lineWidth: 1.04
  },
  {
    radiusFactor: 0.98,
    tiltX: 1.16,
    tiltY: 0.24,
    tiltZ: 0.44,
    tiltDriftX: 0.1,
    tiltDriftY: 0.1,
    tiltDriftZ: 0.08,
    precessionX: -0.22,
    precessionY: 0.46,
    precessionZ: 0.3,
    electronSpeed: 1.32,
    direction: 1,
    phase: 2.22,
    distortion: 0.032,
    breatheSpeed: 0.34,
    breatheAmount: 0.024,
    electronSize: 0.96,
    lineWidth: 1.08
  },
  {
    radiusFactor: 1.16,
    tiltX: -0.42,
    tiltY: 1.18,
    tiltZ: -0.4,
    tiltDriftX: 0.12,
    tiltDriftY: 0.12,
    tiltDriftZ: 0.08,
    precessionX: 0.32,
    precessionY: -0.38,
    precessionZ: 0.24,
    electronSpeed: 1.76,
    direction: -1,
    phase: 3.06,
    distortion: 0.034,
    breatheSpeed: 0.31,
    breatheAmount: 0.026,
    electronSize: 1.08,
    lineWidth: 1.12
  },
  {
    radiusFactor: 1.34,
    tiltX: 0.24,
    tiltY: -1.32,
    tiltZ: 0.56,
    tiltDriftX: 0.14,
    tiltDriftY: 0.1,
    tiltDriftZ: 0.1,
    precessionX: -0.28,
    precessionY: 0.34,
    precessionZ: -0.26,
    electronSpeed: 1.52,
    direction: 1,
    phase: 4.28,
    distortion: 0.036,
    breatheSpeed: 0.28,
    breatheAmount: 0.028,
    electronSize: 1.12,
    lineWidth: 1.18
  }
];

const DEFAULT_PALETTE = [
  {
    color: "#65f2ff",
    glowColor: "rgba(101, 242, 255, 0.6)",
    electronColor: "rgba(220, 252, 255, 0.99)"
  },
  {
    color: "#79b8ff",
    glowColor: "rgba(121, 184, 255, 0.56)",
    electronColor: "rgba(229, 239, 255, 0.99)"
  },
  {
    color: "#9388ff",
    glowColor: "rgba(147, 136, 255, 0.52)",
    electronColor: "rgba(236, 233, 255, 0.99)"
  },
  {
    color: "#c06dff",
    glowColor: "rgba(192, 109, 255, 0.48)",
    electronColor: "rgba(245, 231, 255, 0.99)"
  },
  {
    color: "#ff78d2",
    glowColor: "rgba(255, 120, 210, 0.46)",
    electronColor: "rgba(255, 233, 247, 0.99)"
  },
  {
    color: "#ffb86c",
    glowColor: "rgba(255, 184, 108, 0.4)",
    electronColor: "rgba(255, 243, 225, 0.99)"
  },
  {
    color: "#7effc8",
    glowColor: "rgba(126, 255, 200, 0.42)",
    electronColor: "rgba(231, 255, 246, 0.99)"
  }
];

const ERROR_PALETTE = [
  {
    color: "#ff9ab0",
    glowColor: "rgba(255, 154, 176, 0.58)",
    electronColor: "rgba(255, 239, 243, 0.99)"
  },
  {
    color: "#ff9678",
    glowColor: "rgba(255, 150, 120, 0.52)",
    electronColor: "rgba(255, 238, 231, 0.99)"
  },
  {
    color: "#ffb16d",
    glowColor: "rgba(255, 177, 109, 0.48)",
    electronColor: "rgba(255, 244, 228, 0.99)"
  },
  {
    color: "#ffd36b",
    glowColor: "rgba(255, 211, 107, 0.42)",
    electronColor: "rgba(255, 248, 228, 0.99)"
  },
  {
    color: "#ff7b9b",
    glowColor: "rgba(255, 123, 155, 0.42)",
    electronColor: "rgba(255, 230, 237, 0.99)"
  },
  {
    color: "#ff915e",
    glowColor: "rgba(255, 145, 94, 0.38)",
    electronColor: "rgba(255, 238, 227, 0.99)"
  },
  {
    color: "#ffc88b",
    glowColor: "rgba(255, 200, 139, 0.36)",
    electronColor: "rgba(255, 247, 230, 0.99)"
  }
];

const DEFAULT_VISUAL_CONFIG = Object.freeze({
  orbitCount: 7,
  nucleusScale: 1.16,
  electronSpeedScale: 1.14,
  perspective: 1.14,
  orbitPrecessionScale: 1.22,
  orbitAxisSpread: 0.6,
  orbitRadiusScale: 0.98,
  palette: DEFAULT_PALETTE,
  errorPalette: ERROR_PALETTE
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeNumber(value, fallback, min, max) {
  const nextValue = Number(value);

  if (!Number.isFinite(nextValue)) {
    return fallback;
  }

  return clamp(nextValue, min, max);
}

function resolveHistory(levelHistory) {
  if (!Array.isArray(levelHistory) || levelHistory.length === 0) {
    return DEFAULT_HISTORY;
  }

  return levelHistory.map((value) => clamp(Number(value) || 0, 0, 1));
}

function sampleHistory(history, normalizedIndex) {
  if (history.length === 1) {
    return history[0];
  }

  const wrappedIndex = ((normalizedIndex % 1) + 1) % 1;
  const scaledIndex = wrappedIndex * (history.length - 1);
  const lowerIndex = Math.floor(scaledIndex);
  const upperIndex = Math.min(history.length - 1, lowerIndex + 1);
  const ratio = scaledIndex - lowerIndex;

  return history[lowerIndex] * (1 - ratio) + history[upperIndex] * ratio;
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
  const chunkSize = hex.length === 3 ? 1 : 2;
  const channels = [];

  for (let index = 0; index < hex.length; index += chunkSize) {
    const segment = hex.slice(index, index + chunkSize);
    const fullSegment = chunkSize === 1 ? `${segment}${segment}` : segment;
    channels.push(Number.parseInt(fullSegment, 16));
  }

  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
}

function normalizePaletteEntry(entry, fallbackEntry) {
  const fallback = fallbackEntry ?? DEFAULT_PALETTE[0];
  const resolved = entry && typeof entry === "object" ? entry : {};

  return {
    color: typeof resolved.color === "string" && resolved.color.trim() ? resolved.color : fallback.color,
    glowColor:
      typeof resolved.glowColor === "string" && resolved.glowColor.trim()
        ? resolved.glowColor
        : fallback.glowColor,
    electronColor:
      typeof resolved.electronColor === "string" && resolved.electronColor.trim()
        ? resolved.electronColor
        : fallback.electronColor
  };
}

function resolvePaletteEntries(entries, orbitCount, fallbackEntries) {
  const fallback = Array.isArray(fallbackEntries) && fallbackEntries.length > 0 ? fallbackEntries : DEFAULT_PALETTE;
  const source = Array.isArray(entries) && entries.length > 0 ? entries : fallback;

  return Array.from({ length: orbitCount }, (_, index) => {
    const fallbackEntry = fallback[index % fallback.length];
    const sourceEntry = source[index % source.length];
    return normalizePaletteEntry(sourceEntry, fallbackEntry);
  });
}

function resolveVisualConfig(visualConfig) {
  const source = visualConfig && typeof visualConfig === "object" ? visualConfig : {};
  const orbitCount = Math.round(normalizeNumber(source.orbitCount, DEFAULT_VISUAL_CONFIG.orbitCount, 1, 10));

  return {
    orbitCount,
    nucleusScale: normalizeNumber(source.nucleusScale, DEFAULT_VISUAL_CONFIG.nucleusScale, 0.68, 1.8),
    electronSpeedScale: normalizeNumber(source.electronSpeedScale, DEFAULT_VISUAL_CONFIG.electronSpeedScale, 0.5, 2.8),
    perspective: normalizeNumber(source.perspective, DEFAULT_VISUAL_CONFIG.perspective, 0.74, 1.6),
    orbitPrecessionScale: normalizeNumber(
      source.orbitPrecessionScale,
      DEFAULT_VISUAL_CONFIG.orbitPrecessionScale,
      0.3,
      2.4
    ),
    orbitAxisSpread: normalizeNumber(source.orbitAxisSpread, DEFAULT_VISUAL_CONFIG.orbitAxisSpread, 0, 1.8),
    orbitRadiusScale: normalizeNumber(source.orbitRadiusScale, DEFAULT_VISUAL_CONFIG.orbitRadiusScale, 0.72, 1.18),
    palette: resolvePaletteEntries(source.palette, orbitCount, DEFAULT_VISUAL_CONFIG.palette),
    errorPalette: resolvePaletteEntries(source.errorPalette, orbitCount, DEFAULT_VISUAL_CONFIG.errorPalette)
  };
}

function buildOrbitShapes(orbitCount, visualConfig) {
  return Array.from({ length: orbitCount }, (_, index) => {
    const template = BASE_ORBIT_SHAPES[index % BASE_ORBIT_SHAPES.length];
    const cycle = Math.floor(index / BASE_ORBIT_SHAPES.length);
    const spreadBias = index % 2 === 0 ? 1 : -1;
    const wave = Math.sin(index * 1.17 + cycle * 0.62);

    return {
      ...template,
      radiusFactor: template.radiusFactor + cycle * 0.16 + wave * 0.026,
      tiltX: template.tiltX + visualConfig.orbitAxisSpread * 0.22 * spreadBias,
      tiltY: template.tiltY + visualConfig.orbitAxisSpread * 0.18 * Math.cos(index * 0.92),
      tiltZ: template.tiltZ + visualConfig.orbitAxisSpread * 0.14 * Math.sin(index * 0.76),
      tiltDriftX: template.tiltDriftX * (1 + visualConfig.orbitAxisSpread * 0.22),
      tiltDriftY: template.tiltDriftY * (1 + visualConfig.orbitAxisSpread * 0.18),
      tiltDriftZ: template.tiltDriftZ * (1 + visualConfig.orbitAxisSpread * 0.24),
      precessionX:
        (template.precessionX + visualConfig.orbitAxisSpread * 0.2 * Math.sin(index * 0.92 + 0.34)) *
        visualConfig.orbitPrecessionScale,
      precessionY:
        (template.precessionY + visualConfig.orbitAxisSpread * 0.18 * Math.cos(index * 1.06 + 0.62)) *
        visualConfig.orbitPrecessionScale,
      precessionZ:
        (template.precessionZ + visualConfig.orbitAxisSpread * 0.12 * spreadBias) *
        visualConfig.orbitPrecessionScale,
      electronSpeed: template.electronSpeed * visualConfig.electronSpeedScale * (1 + wave * 0.06),
      phase: template.phase + index * 0.34 + cycle * 0.42,
      distortion: clamp(template.distortion + cycle * 0.004 + Math.abs(wave) * 0.003, 0.016, 0.07),
      breatheSpeed: clamp(template.breatheSpeed - cycle * 0.02 + Math.abs(wave) * 0.01, 0.16, 0.58),
      breatheAmount: template.breatheAmount + cycle * 0.002,
      electronSize: clamp(template.electronSize - cycle * 0.02 + Math.abs(wave) * 0.04, 0.8, 1.24),
      lineWidth: template.lineWidth + cycle * 0.06
    };
  });
}

function createProjection(perspectiveStrength) {
  const strength = clamp(perspectiveStrength, 0.74, 1.6);
  const cameraDistance = BASE_CAMERA_DISTANCE / strength;

  return {
    cameraDistance,
    minDistance: cameraDistance * 0.3,
    minScale: clamp(0.62 - (strength - 1) * 0.1, 0.5, 0.66),
    maxScale: clamp(1.84 + (strength - 1) * 0.48, 1.68, 2.28)
  };
}

function rotateX(point, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return {
    x: point.x,
    y: point.y * cos - point.z * sin,
    z: point.y * sin + point.z * cos
  };
}

function rotateY(point, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return {
    x: point.x * cos + point.z * sin,
    y: point.y,
    z: -point.x * sin + point.z * cos
  };
}

function rotateZ(point, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
    z: point.z
  };
}

function projectPoint(point, cx, cy, projection) {
  const perspective =
    projection.cameraDistance /
    Math.max(projection.minDistance, projection.cameraDistance - point.z);
  const scale = clamp(perspective, projection.minScale, projection.maxScale);

  return {
    x: cx + point.x * scale,
    y: cy + point.y * scale,
    z: point.z,
    scale
  };
}

function drawAmbientBackground(context, width, height, cx, cy, radius, palette, energy) {
  const inner = palette[1] ?? palette[0] ?? DEFAULT_PALETTE[0];
  const outer = palette[palette.length - 1] ?? inner;
  const base = context.createRadialGradient(cx, cy, radius * 0.14, cx, cy, Math.max(width, height) * 0.8);
  base.addColorStop(0, withAlpha(inner.color, 0.24));
  base.addColorStop(0.44, withAlpha(outer.color, 0.16));
  base.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = base;
  context.fillRect(0, 0, width, height);

  const aura = context.createRadialGradient(cx, cy, radius * 0.08, cx, cy, radius * (2.86 + energy * 0.66));
  aura.addColorStop(0, withAlpha(inner.electronColor, 0.14));
  aura.addColorStop(0.58, withAlpha(outer.glowColor, 0.1 + energy * 0.03));
  aura.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = aura;
  context.fillRect(0, 0, width, height);
}

function orientOrbitPoint(point, orbit, time) {
  let nextPoint = rotateZ(point, orbit.tiltZ);
  nextPoint = rotateX(nextPoint, orbit.tiltX + Math.sin(time * 0.44 + orbit.phase) * orbit.tiltDriftX);
  nextPoint = rotateY(nextPoint, orbit.tiltY + Math.cos(time * 0.38 + orbit.phase * 1.4) * orbit.tiltDriftY);
  nextPoint = rotateZ(nextPoint, Math.sin(time * 0.32 + orbit.phase * 0.8) * orbit.tiltDriftZ);
  nextPoint = rotateY(nextPoint, time * orbit.precessionY + orbit.phase * 1.08);
  nextPoint = rotateX(nextPoint, time * orbit.precessionX + orbit.phase * 0.72);
  nextPoint = rotateZ(nextPoint, time * orbit.precessionZ + orbit.phase * 0.46);
  return nextPoint;
}

function buildOrbitPoints({
  cx,
  cy,
  radius,
  history,
  orbit,
  time,
  energy,
  orbitIndex,
  projection
}) {
  const points = [];
  const pointCount = 260;
  const orbitBreath = 1 + Math.sin(time * orbit.breatheSpeed + orbit.phase) * orbit.breatheAmount * (0.8 + energy * 0.28);

  for (let index = 0; index <= pointCount; index += 1) {
    const progress = index / pointCount;
    const angle = progress * TAU;
    const historyValue = sampleHistory(history, progress + orbitIndex * 0.09 + time * 0.022);
    const localRipple =
      Math.sin(angle * 2 + time * (0.2 + orbitIndex * 0.04) + orbit.phase) * 0.55 +
      Math.cos(angle * 4 - time * 0.16 + orbit.phase * 0.9) * 0.45;
    const dynamicRadius =
      radius * orbitBreath * (1 + historyValue * 0.022 + localRipple * orbit.distortion * (0.72 + energy * 0.18));

    let point = {
      x: Math.cos(angle) * dynamicRadius,
      y: Math.sin(angle) * dynamicRadius,
      z: 0
    };

    point = orientOrbitPoint(point, orbit, time);

    const projected = projectPoint(point, cx, cy, projection);
    points.push(projected);
  }

  return points;
}

function strokeOrbitSide(context, points, color, lineWidth, alpha, shadowBlur, predicate) {
  let drawing = false;

  context.beginPath();

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];

    if (predicate(point)) {
      if (!drawing) {
        context.moveTo(point.x, point.y);
        drawing = true;
      } else {
        context.lineTo(point.x, point.y);
      }
    } else if (drawing) {
      drawing = false;
    }
  }

  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.shadowColor = color;
  context.shadowBlur = shadowBlur;
  context.globalAlpha = alpha;
  context.stroke();
}

function drawOrbitGlow(context, cx, cy, radius, glowColor, energy) {
  const halo = context.createRadialGradient(cx, cy, radius * 0.66, cx, cy, radius * 1.38);
  halo.addColorStop(0, "rgba(255, 255, 255, 0)");
  halo.addColorStop(0.52, withAlpha(glowColor, 0.08 + energy * 0.04));
  halo.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = halo;
  context.fillRect(cx - radius * 1.5, cy - radius * 1.5, radius * 3, radius * 3);
}

function drawElectronTrail(context, points, orbit, palette, electronProgress, radius, energy, drawFront) {
  const trailCount = 8;

  for (let index = trailCount; index >= 0; index -= 1) {
    const progress = electronProgress - index * 0.016 * orbit.direction;
    const wrappedProgress = ((progress % 1) + 1) % 1;
    const pointIndex = Math.round(wrappedProgress * (points.length - 1));
    const point = points[pointIndex];

    if (!point) {
      continue;
    }

    const isFront = point.z >= 0;

    if (isFront !== drawFront) {
      continue;
    }

    const fade = 1 - index / (trailCount + 1);
    const particleRadius = radius * 0.022 * orbit.electronSize * point.scale * (0.84 + energy * 0.3) * fade;

    context.save();
    context.fillStyle = withAlpha(palette.electronColor, 0.28 + fade * 0.54 + point.scale * 0.06);
    context.shadowColor = palette.color;
    context.shadowBlur = 12 + fade * 18 + energy * 10;
    context.globalAlpha = 0.32 + fade * 0.44;
    context.beginPath();
    context.arc(point.x, point.y, particleRadius, 0, TAU);
    context.fill();
    context.restore();
  }
}

function drawElectronHead(context, points, orbit, palette, electronProgress, radius, energy, drawFront) {
  const wrappedProgress = ((electronProgress % 1) + 1) % 1;
  const pointIndex = Math.round(wrappedProgress * (points.length - 1));
  const point = points[pointIndex];

  if (!point || (point.z >= 0) !== drawFront) {
    return;
  }

  const electronRadius = radius * 0.03 * orbit.electronSize * point.scale * (0.9 + energy * 0.28);
  const electronGlow = context.createRadialGradient(
    point.x,
    point.y,
    electronRadius * 0.25,
    point.x,
    point.y,
    electronRadius * 2.2
  );
  electronGlow.addColorStop(0, palette.electronColor);
  electronGlow.addColorStop(0.48, withAlpha(palette.glowColor, 0.72));
  electronGlow.addColorStop(1, "rgba(0, 0, 0, 0)");

  context.save();
  context.globalAlpha = drawFront ? 0.96 : 0.44;
  context.fillStyle = electronGlow;
  context.beginPath();
  context.arc(point.x, point.y, electronRadius * 2.2, 0, TAU);
  context.fill();
  context.restore();

  context.save();
  context.fillStyle = palette.electronColor;
  context.shadowColor = palette.color;
  context.shadowBlur = 18 + energy * 14;
  context.globalAlpha = drawFront ? 1 : 0.52;
  context.beginPath();
  context.arc(point.x, point.y, electronRadius, 0, TAU);
  context.fill();
  context.restore();
}

function createOrbitModel(params) {
  const {
    cx,
    cy,
    history,
    orbit,
    palette,
    time,
    orbitIndex,
    energy,
    baseRadius,
    projection
  } = params;

  const radius = baseRadius * orbit.radiusFactor * (1 + energy * 0.08);
  const points = buildOrbitPoints({
    cx,
    cy,
    radius,
    history,
    orbit,
    time,
    energy,
    orbitIndex,
    projection
  });
  const electronProgress =
    (time * orbit.electronSpeed * 0.16 * orbit.direction + orbit.phase / TAU + energy * 0.012) % 1;

  return {
    orbit,
    palette,
    radius,
    points,
    energy,
    electronProgress,
    cx,
    cy
  };
}

function drawOrbitBack(context, orbitModel) {
  const { cx, cy, radius, palette, energy, points, orbit, electronProgress } = orbitModel;

  drawOrbitGlow(context, cx, cy, radius, palette.glowColor, energy);
  strokeOrbitSide(
    context,
    points,
    palette.color,
    orbit.lineWidth + energy * 0.34,
    0.12 + energy * 0.07,
    8 + energy * 10,
    (point) => point.z < 0
  );
  drawElectronTrail(context, points, orbit, palette, electronProgress, radius, energy, false);
  drawElectronHead(context, points, orbit, palette, electronProgress, radius, energy, false);
}

function drawOrbitFront(context, orbitModel) {
  const { radius, palette, energy, points, orbit, electronProgress } = orbitModel;

  strokeOrbitSide(
    context,
    points,
    palette.color,
    orbit.lineWidth + 0.22 + energy * 0.56,
    0.24 + energy * 0.12,
    16 + energy * 18,
    (point) => point.z >= 0
  );
  drawElectronTrail(context, points, orbit, palette, electronProgress, radius, energy, true);
  drawElectronHead(context, points, orbit, palette, electronProgress, radius, energy, true);
}

function buildNucleusPalette(activePalette) {
  const core = activePalette[Math.floor(activePalette.length / 2)] ?? DEFAULT_PALETTE[2];
  const inner = activePalette[1] ?? activePalette[0] ?? core;
  const outer = activePalette[activePalette.length - 1] ?? core;

  return {
    outerGlowStart: withAlpha(inner.electronColor, 0.78),
    outerGlowMid: withAlpha(core.glowColor, 0.4),
    coronaStart: "rgba(255, 255, 255, 0.96)",
    coronaMid: withAlpha(inner.electronColor, 0.5),
    coreStart: "rgba(255, 255, 255, 0.99)",
    coreMid: withAlpha(core.color, 0.92),
    coreEnd: withAlpha(outer.color, 0.48),
    particleFill: withAlpha(inner.electronColor, 0.76),
    particleGlow: withAlpha(core.color, 0.8)
  };
}

function drawNucleus(context, cx, cy, radius, energy, time, nucleusPalette) {
  const outerGlow = context.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius * (2.08 + energy * 0.44));
  outerGlow.addColorStop(0, nucleusPalette.outerGlowStart);
  outerGlow.addColorStop(0.28, nucleusPalette.outerGlowMid);
  outerGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = outerGlow;
  context.beginPath();
  context.arc(cx, cy, radius * (1.68 + energy * 0.18), 0, TAU);
  context.fill();

  const corona = context.createRadialGradient(cx, cy, radius * 0.16, cx, cy, radius * 1.22);
  corona.addColorStop(0, nucleusPalette.coronaStart);
  corona.addColorStop(0.48, nucleusPalette.coronaMid);
  corona.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = corona;
  context.beginPath();
  context.arc(cx, cy, radius * 1.16, 0, TAU);
  context.fill();

  const core = context.createRadialGradient(cx - radius * 0.22, cy - radius * 0.24, radius * 0.12, cx, cy, radius);
  core.addColorStop(0, nucleusPalette.coreStart);
  core.addColorStop(0.38, nucleusPalette.coreMid);
  core.addColorStop(1, nucleusPalette.coreEnd);
  context.fillStyle = core;
  context.beginPath();
  context.arc(cx, cy, radius, 0, TAU);
  context.fill();

  for (let index = 0; index < 6; index += 1) {
    const angle = time * (0.92 + index * 0.14) + index * 1.12;
    const pulse = 0.44 + Math.sin(time * 1.72 + index * 0.9) * 0.16;
    const particleRadius = radius * (0.1 + index * 0.015) * (1 + energy * 0.14);
    const particleX = cx + Math.cos(angle) * radius * 0.34 * pulse;
    const particleY = cy + Math.sin(angle * 1.16) * radius * 0.24 * pulse;

    context.save();
    context.fillStyle = nucleusPalette.particleFill;
    context.shadowColor = nucleusPalette.particleGlow;
    context.shadowBlur = 12 + energy * 10;
    context.globalAlpha = 0.48 + energy * 0.14;
    context.beginPath();
    context.arc(particleX, particleY, particleRadius, 0, TAU);
    context.fill();
    context.restore();
  }
}

export default function VoiceOrb({
  audioLevel = 0,
  levelHistory = [],
  isListening = false,
  isResponding = false,
  connectionState = "idle",
  visualConfig = null
}) {
  const canvasRef = useRef(null);
  const smoothedLevelRef = useRef(0);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
  const drawStateRef = useRef({
    audioLevel,
    levelHistory,
    isListening,
    isResponding,
    connectionState
  });
  const resolvedVisualConfig = useMemo(() => resolveVisualConfig(visualConfig), [visualConfig]);
  const orbitShapes = useMemo(
    () => buildOrbitShapes(resolvedVisualConfig.orbitCount, resolvedVisualConfig),
    [resolvedVisualConfig]
  );
  const projection = useMemo(
    () => createProjection(resolvedVisualConfig.perspective),
    [resolvedVisualConfig.perspective]
  );

  useEffect(() => {
    drawStateRef.current = {
      audioLevel,
      levelHistory,
      isListening,
      isResponding,
      connectionState
    };
  }, [audioLevel, connectionState, isListening, isResponding, levelHistory]);

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
      const previousSize = sizeRef.current;

      if (
        previousSize.width !== nextWidth ||
        previousSize.height !== nextHeight ||
        previousSize.dpr !== nextDpr
      ) {
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
      const drawState = drawStateRef.current;
      const history = resolveHistory(drawState.levelHistory);
      const historyPeak = history.reduce((max, value) => Math.max(max, value), 0);
      const historyAverage = history.reduce((sum, value) => sum + value, 0) / history.length;
      const responseBoost = drawState.isResponding ? 0.24 : 0;
      const listeningBoost = drawState.isListening ? 0.1 : 0;
      const targetLevel = clamp(Number(drawState.audioLevel) + responseBoost + listeningBoost, 0, 1.25);
      const smoothedLevel = smoothedLevelRef.current + (targetLevel - smoothedLevelRef.current) * 0.16;
      const energy = clamp(smoothedLevel * 0.9 + historyAverage * 0.42 + historyPeak * 0.22, 0, 1.35);
      const orbitDensityCompensation = 1 - Math.max(0, orbitShapes.length - 5) * 0.022;
      const baseRadius = Math.min(width, height) * (0.132 + energy * 0.026);
      const orbitRadius =
        Math.min(width, height) *
        (0.178 + energy * 0.028) *
        resolvedVisualConfig.orbitRadiusScale *
        clamp(orbitDensityCompensation, 0.84, 1);
      const nucleusRadius = baseRadius * resolvedVisualConfig.nucleusScale * (1 + energy * 0.12);
      const time = performance.now() * 0.001;
      const isError = drawState.connectionState === "error";
      const activePalette = isError ? resolvedVisualConfig.errorPalette : resolvedVisualConfig.palette;
      const nucleusPalette = buildNucleusPalette(activePalette);

      smoothedLevelRef.current = smoothedLevel;
      context.clearRect(0, 0, width, height);

      drawAmbientBackground(context, width, height, cx, cy, orbitRadius, activePalette, energy);

      context.save();
      context.globalCompositeOperation = "screen";

      const orbitModels = orbitShapes.map((orbit, orbitIndex) =>
        createOrbitModel({
          cx,
          cy,
          history,
          orbit,
          palette: activePalette[orbitIndex],
          time,
          orbitIndex,
          energy,
          baseRadius: orbitRadius,
          projection
        })
      );

      orbitModels.forEach((orbitModel) => {
        drawOrbitBack(context, orbitModel);
      });

      drawNucleus(context, cx, cy, nucleusRadius, energy, time, nucleusPalette);

      orbitModels.forEach((orbitModel) => {
        drawOrbitFront(context, orbitModel);
      });

      context.restore();
      raf = window.requestAnimationFrame(draw);
    };

    raf = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [orbitShapes, projection, resolvedVisualConfig]);

  return <canvas ref={canvasRef} className="voice-mode-panel__orb-canvas" aria-hidden="true" />;
}
