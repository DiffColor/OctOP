import { useEffect, useMemo, useRef } from "react";

const TAU = Math.PI * 2;
const MIN_CANVAS_SIZE = 260;
const DEFAULT_HISTORY = Array.from({ length: 24 }, () => 0.08);

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
  palette: DEFAULT_PALETTE,
  errorPalette: ERROR_PALETTE
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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
  const ribbonCount = Math.round(normalizeNumber(source.orbitCount, DEFAULT_VISUAL_CONFIG.orbitCount, 3, 7));

  return {
    ribbonCount,
    nucleusScale: normalizeNumber(source.nucleusScale, DEFAULT_VISUAL_CONFIG.nucleusScale, 0.84, 1.32),
    palette: resolvePalette(source.palette, ribbonCount, DEFAULT_VISUAL_CONFIG.palette),
    errorPalette: resolvePalette(source.errorPalette, ribbonCount, DEFAULT_VISUAL_CONFIG.errorPalette)
  };
}

function createRibbonModels(ribbonCount) {
  return Array.from({ length: ribbonCount }, (_, index) => {
    const isMagenta = index >= Math.ceil(ribbonCount / 2);
    const groupOffset = index % Math.ceil(ribbonCount / 2);

    return {
      rotation: index * (Math.PI / ribbonCount) + (isMagenta ? 0.6 : 0),
      direction: index % 2 === 0 ? 1 : -1,
      loopScale: isMagenta ? 0.58 + groupOffset * 0.03 : 0.56 + groupOffset * 0.035,
      lobeScale: isMagenta ? 0.34 + groupOffset * 0.02 : 0.28 + groupOffset * 0.025,
      squash: isMagenta ? 0.76 : 0.68,
      wave: 3 + (index % 3),
      secondaryWave: 4 + ((index + 1) % 3),
      phase: index * 1.17 + (isMagenta ? 0.9 : 0.2),
      lineWidth: isMagenta ? 0.13 + groupOffset * 0.012 : 0.11 + groupOffset * 0.014,
      alpha: isMagenta ? 0.78 : 0.84,
      blurBoost: isMagenta ? 1.06 : 0.96
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

function drawRibbon(context, cx, cy, radius, ribbon, paletteEntry, time, energy) {
  const motion = time * (0.42 + energy * 0.18) * ribbon.direction + ribbon.phase;
  const pointCount = 160;
  const points = [];

  for (let index = 0; index <= pointCount; index += 1) {
    const progress = index / pointCount;
    const angle = progress * TAU;
    const ringRadius =
      radius * ribbon.loopScale *
      (1 + Math.sin(angle * ribbon.wave + motion) * (0.065 + energy * 0.025) + Math.cos(angle * ribbon.secondaryWave - motion * 1.2) * 0.018);
    const lobe = radius * ribbon.lobeScale * (0.78 + Math.sin(angle * 2 - motion * 0.72) * 0.18);
    const localRotation = angle + ribbon.rotation + Math.sin(motion * 0.12) * 0.08;

    const x = cx + Math.cos(localRotation) * ringRadius + Math.cos(localRotation * 2 + motion * 0.48) * lobe;
    const y = cy + Math.sin(localRotation) * ringRadius * ribbon.squash + Math.sin(localRotation * 3 - motion) * lobe * 0.58;
    points.push({ x, y });
  }

  const gradient = context.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
  gradient.addColorStop(0, withAlpha(paletteEntry.electronColor, 0.18));
  gradient.addColorStop(0.22, withAlpha(paletteEntry.color, 0.72));
  gradient.addColorStop(0.58, withAlpha(paletteEntry.glowColor, 0.42));
  gradient.addColorStop(1, withAlpha(paletteEntry.electronColor, 0.16));

  context.save();
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const midX = (previous.x + current.x) * 0.5;
    const midY = (previous.y + current.y) * 0.5;
    context.quadraticCurveTo(previous.x, previous.y, midX, midY);
  }

  context.closePath();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = gradient;
  context.lineWidth = radius * ribbon.lineWidth * (1 + energy * 0.12);
  context.shadowColor = withAlpha(paletteEntry.color, 0.44 + energy * 0.08);
  context.shadowBlur = radius * 0.16 * ribbon.blurBoost;
  context.globalAlpha = ribbon.alpha;
  context.stroke();
  context.restore();

  context.save();
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const midX = (previous.x + current.x) * 0.5;
    const midY = (previous.y + current.y) * 0.5;
    context.quadraticCurveTo(previous.x, previous.y, midX, midY);
  }

  context.closePath();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = withAlpha(paletteEntry.electronColor, 0.22 + energy * 0.08);
  context.lineWidth = radius * ribbon.lineWidth * 0.28;
  context.globalAlpha = 0.8;
  context.stroke();
  context.restore();
}

function drawHotCore(context, cx, cy, radius, palette, energy, time, nucleusScale) {
  const cyan = palette[0] ?? DEFAULT_PALETTE[0];
  const magenta = palette[Math.max(0, palette.length - 1)] ?? DEFAULT_PALETTE[2];
  const coreRadius = radius * 0.24 * nucleusScale * (1 + energy * 0.08);

  const glow = context.createRadialGradient(cx, cy, coreRadius * 0.1, cx, cy, coreRadius * 3.4);
  glow.addColorStop(0, "rgba(255, 255, 255, 0.58)");
  glow.addColorStop(0.2, withAlpha(cyan.electronColor, 0.24 + energy * 0.08));
  glow.addColorStop(0.58, withAlpha(magenta.color, 0.12 + energy * 0.05));
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = glow;
  context.beginPath();
  context.arc(cx, cy, coreRadius * 2.6, 0, TAU);
  context.fill();

  const core = context.createRadialGradient(cx - coreRadius * 0.24, cy - coreRadius * 0.3, coreRadius * 0.08, cx, cy, coreRadius);
  core.addColorStop(0, "rgba(255, 255, 255, 0.95)");
  core.addColorStop(0.46, withAlpha(cyan.color, 0.82));
  core.addColorStop(1, withAlpha(magenta.color, 0.34));
  context.fillStyle = core;
  context.beginPath();
  context.arc(cx, cy, coreRadius, 0, TAU);
  context.fill();

  for (let index = 0; index < 9; index += 1) {
    const angle = time * (0.46 + index * 0.04) + index * 0.82;
    const particleRadius = coreRadius * (0.08 + (index % 3) * 0.018) * (1 + energy * 0.1);
    const particleX = cx + Math.cos(angle) * coreRadius * (0.74 + (index % 2) * 0.12);
    const particleY = cy + Math.sin(angle * 1.14) * coreRadius * (0.62 + (index % 3) * 0.08);

    context.save();
    context.fillStyle = index % 2 === 0 ? withAlpha(cyan.electronColor, 0.48) : withAlpha(magenta.electronColor, 0.4);
    context.shadowColor = index % 2 === 0 ? cyan.color : magenta.color;
    context.shadowBlur = coreRadius * 0.44;
    context.globalAlpha = 0.72;
    context.beginPath();
    context.arc(particleX, particleY, particleRadius, 0, TAU);
    context.fill();
    context.restore();
  }
}

function drawParticles(context, cx, cy, radius, palette, energy, time) {
  const cyan = palette[0] ?? DEFAULT_PALETTE[0];
  const magenta = palette[Math.max(0, palette.length - 1)] ?? DEFAULT_PALETTE[2];

  for (let index = 0; index < 26; index += 1) {
    const angle = (index / 26) * TAU + time * 0.06 * (index % 2 === 0 ? 1 : -1);
    const distance = radius * (0.16 + ((index * 7) % 13) * 0.055);
    const x = cx + Math.cos(angle * 1.18 + index * 0.37) * distance;
    const y = cy + Math.sin(angle * 0.94 + index * 0.29) * distance * 0.84;
    const size = radius * 0.005 + (index % 4) * radius * 0.0014;

    context.save();
    context.fillStyle = index % 2 === 0 ? withAlpha(cyan.electronColor, 0.44) : withAlpha(magenta.electronColor, 0.34);
    context.globalAlpha = 0.3 + energy * 0.18;
    context.beginPath();
    context.arc(x, y, size, 0, TAU);
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
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
  const drawStateRef = useRef({
    audioLevel,
    levelHistory,
    isListening,
    isResponding,
    connectionState
  });
  const smoothedLevelRef = useRef(0);

  const resolvedVisualConfig = useMemo(() => resolveVisualConfig(visualConfig), [visualConfig]);
  const ribbonModels = useMemo(() => createRibbonModels(resolvedVisualConfig.ribbonCount), [resolvedVisualConfig.ribbonCount]);

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
      const time = performance.now() * 0.001;
      const state = drawStateRef.current;
      const history = resolveHistory(state.levelHistory);
      const historyAverage = history.reduce((sum, entry) => sum + entry, 0) / history.length;
      const historyPeak = history.reduce((maxValue, entry) => Math.max(maxValue, entry), 0);
      const responseBoost = state.isResponding ? 0.22 : 0;
      const listeningBoost = state.isListening ? 0.12 : 0;
      const targetLevel = clamp(Number(state.audioLevel) + responseBoost + listeningBoost, 0, 1.24);
      const smoothed = smoothedLevelRef.current + (targetLevel - smoothedLevelRef.current) * 0.14;
      const energy = clamp(smoothed * 0.72 + historyAverage * 0.42 + historyPeak * 0.18, 0.08, 1.2);
      const activePalette = state.connectionState === "error" ? resolvedVisualConfig.errorPalette : resolvedVisualConfig.palette;

      smoothedLevelRef.current = smoothed;

      context.clearRect(0, 0, width, height);
      drawAtmosphere(context, width, height, cx, cy, radius, activePalette, energy);
      drawOuterShell(context, cx, cy, radius, activePalette, energy);

      context.save();
      context.beginPath();
      context.arc(cx, cy, radius * 0.93, 0, TAU);
      context.clip();
      context.globalCompositeOperation = "screen";

      drawInnerGlass(context, cx, cy, radius, activePalette, energy);

      ribbonModels.forEach((ribbon, index) => {
        drawRibbon(context, cx, cy, radius, ribbon, activePalette[index % activePalette.length], time, energy);
      });

      drawHotCore(context, cx, cy, radius, activePalette, energy, time, resolvedVisualConfig.nucleusScale);
      drawParticles(context, cx, cy, radius, activePalette, energy, time);
      context.restore();

      raf = window.requestAnimationFrame(draw);
    };

    raf = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [resolvedVisualConfig, ribbonModels]);

  return <canvas ref={canvasRef} className="voice-mode-panel__orb-canvas" aria-hidden="true" />;
}
