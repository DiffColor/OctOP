import { useEffect, useRef } from "react";

const TAU = Math.PI * 2;
const MIN_CANVAS_SIZE = 220;
const CAMERA_DISTANCE = 520;
const DEFAULT_HISTORY = Array.from({ length: 24 }, () => 0.08);

const ORBIT_SHAPES = [
  {
    radiusFactor: 0.82,
    tiltX: -0.96,
    tiltY: 0.48,
    spinSpeed: 0.58,
    direction: 1,
    phase: 0.18,
    distortion: 0.08,
    wobble: 0.16,
    electronSize: 1
  },
  {
    radiusFactor: 1,
    tiltX: 0.82,
    tiltY: -0.92,
    spinSpeed: 0.72,
    direction: -1,
    phase: 1.22,
    distortion: 0.1,
    wobble: 0.18,
    electronSize: 1.12
  },
  {
    radiusFactor: 1.16,
    tiltX: 1.14,
    tiltY: 0.24,
    spinSpeed: 0.46,
    direction: 1,
    phase: 2.36,
    distortion: 0.12,
    wobble: 0.2,
    electronSize: 0.96
  },
  {
    radiusFactor: 1.34,
    tiltX: -0.36,
    tiltY: 1.18,
    spinSpeed: 0.84,
    direction: -1,
    phase: 3.18,
    distortion: 0.13,
    wobble: 0.22,
    electronSize: 1.08
  }
];

const DEFAULT_PALETTE = [
  {
    color: "#72f6ff",
    glowColor: "rgba(114, 246, 255, 0.58)",
    electronColor: "rgba(206, 252, 255, 0.98)"
  },
  {
    color: "#9d7dff",
    glowColor: "rgba(157, 125, 255, 0.52)",
    electronColor: "rgba(228, 220, 255, 0.98)"
  },
  {
    color: "#ff7fd0",
    glowColor: "rgba(255, 127, 208, 0.48)",
    electronColor: "rgba(255, 226, 244, 0.98)"
  },
  {
    color: "#6ca4ff",
    glowColor: "rgba(108, 164, 255, 0.42)",
    electronColor: "rgba(221, 234, 255, 0.98)"
  }
];

const ERROR_PALETTE = [
  {
    color: "#ff9ab0",
    glowColor: "rgba(255, 154, 176, 0.54)",
    electronColor: "rgba(255, 235, 240, 0.98)"
  },
  {
    color: "#ff8f77",
    glowColor: "rgba(255, 143, 119, 0.5)",
    electronColor: "rgba(255, 235, 228, 0.98)"
  },
  {
    color: "#ffd289",
    glowColor: "rgba(255, 210, 137, 0.42)",
    electronColor: "rgba(255, 246, 224, 0.98)"
  },
  {
    color: "#ff6d9d",
    glowColor: "rgba(255, 109, 157, 0.38)",
    electronColor: "rgba(255, 228, 237, 0.98)"
  }
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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
  const match = String(color)
    .trim()
    .match(/rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*[0-9.]+)?\s*\)/i);

  if (!match) {
    return color;
  }

  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
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

function projectPoint(point, cx, cy) {
  const perspective = CAMERA_DISTANCE / (CAMERA_DISTANCE - point.z);

  return {
    x: cx + point.x * perspective,
    y: cy + point.y * perspective,
    z: point.z,
    scale: perspective
  };
}

function drawAmbientBackground(context, width, height, cx, cy, radius, isError, energy) {
  const base = context.createRadialGradient(cx, cy, radius * 0.14, cx, cy, Math.max(width, height) * 0.74);
  base.addColorStop(0, isError ? "rgba(88, 24, 28, 0.26)" : "rgba(24, 34, 98, 0.26)");
  base.addColorStop(0.48, isError ? "rgba(34, 10, 14, 0.14)" : "rgba(8, 12, 38, 0.14)");
  base.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = base;
  context.fillRect(0, 0, width, height);

  const aura = context.createRadialGradient(cx, cy, radius * 0.08, cx, cy, radius * (2.4 + energy * 0.65));
  aura.addColorStop(0, isError ? "rgba(255, 182, 170, 0.12)" : "rgba(187, 199, 255, 0.14)");
  aura.addColorStop(0.58, isError ? "rgba(255, 126, 148, 0.07)" : "rgba(113, 164, 255, 0.08)");
  aura.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = aura;
  context.fillRect(0, 0, width, height);
}

function buildOrbitPoints({
  cx,
  cy,
  radius,
  history,
  orbit,
  time,
  energy,
  orbitIndex
}) {
  const points = [];
  const pointCount = 240;
  const spin = time * orbit.spinSpeed * orbit.direction + orbit.phase;
  const wobbleX = orbit.tiltX + Math.sin(time * 0.54 + orbit.phase) * orbit.wobble;
  const wobbleY = orbit.tiltY + Math.cos(time * 0.44 + orbit.phase * 1.7) * orbit.wobble;
  const wobbleZ = spin + Math.sin(time * 0.28 + orbit.phase) * 0.18;

  for (let index = 0; index <= pointCount; index += 1) {
    const progress = index / pointCount;
    const angle = progress * TAU;
    const historyValue = sampleHistory(history, progress + orbitIndex * 0.11 + spin * 0.032);
    const distortionWave =
      Math.sin(angle * (3 + orbitIndex) + time * (0.78 + orbitIndex * 0.08) + orbit.phase) * 0.55 +
      Math.cos(angle * (5 + orbitIndex * 2) - time * 0.62 + historyValue * 3.2) * 0.45;
    const dynamicRadius = radius * (
      1 + distortionWave * orbit.distortion * (0.18 + energy * 0.32) + historyValue * 0.065
    );

    let point = {
      x: Math.cos(angle) * dynamicRadius,
      y: Math.sin(angle) * dynamicRadius,
      z: Math.sin(angle * 2 + spin) * radius * (0.04 + energy * 0.012)
    };

    point = rotateZ(point, wobbleZ);
    point = rotateX(point, wobbleX);
    point = rotateY(point, wobbleY);

    const projected = projectPoint(point, cx, cy);
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
  const halo = context.createRadialGradient(cx, cy, radius * 0.7, cx, cy, radius * 1.3);
  halo.addColorStop(0, "rgba(255, 255, 255, 0)");
  halo.addColorStop(0.54, withAlpha(glowColor, 0.08 + energy * 0.04));
  halo.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = halo;
  context.fillRect(cx - radius * 1.4, cy - radius * 1.4, radius * 2.8, radius * 2.8);
}

function drawElectronTrail(context, points, orbit, palette, electronProgress, radius, energy, drawFront) {
  const trailCount = 7;

  for (let index = trailCount; index >= 0; index -= 1) {
    const progress = electronProgress - index * 0.018 * orbit.direction;
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
    const particleRadius = radius * 0.024 * orbit.electronSize * point.scale * (0.8 + energy * 0.32) * fade;

    context.save();
    context.fillStyle = withAlpha(palette.electronColor, 0.24 + fade * 0.52 + point.scale * 0.08);
    context.shadowColor = palette.color;
    context.shadowBlur = 10 + fade * 20 + energy * 10;
    context.globalAlpha = 0.34 + fade * 0.4;
    context.beginPath();
    context.arc(point.x, point.y, particleRadius, 0, TAU);
    context.fill();
    context.restore();
  }
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
    baseRadius
  } = params;

  const radius = baseRadius * orbit.radiusFactor * (1 + energy * 0.12);
  const points = buildOrbitPoints({
    cx,
    cy,
    radius,
    history,
    orbit,
    time,
    energy,
    orbitIndex
  });
  const electronProgress = (time * orbit.spinSpeed * 0.22 * orbit.direction + orbit.phase / TAU) % 1;

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
  strokeOrbitSide(context, points, palette.color, 1 + energy * 0.5, 0.14 + energy * 0.08, 8 + energy * 12, (point) => point.z < 0);
  drawElectronTrail(context, points, orbit, palette, electronProgress, radius, energy, false);
}

function drawOrbitFront(context, orbitModel) {
  const { radius, palette, energy, points, orbit, electronProgress } = orbitModel;

  strokeOrbitSide(context, points, palette.color, 1.3 + energy * 0.75, 0.26 + energy * 0.12, 16 + energy * 18, (point) => point.z >= 0);
  drawElectronTrail(context, points, orbit, palette, electronProgress, radius, energy, true);
}

function drawNucleus(context, cx, cy, radius, energy, isError, time) {
  const outerGlow = context.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius * (1.8 + energy * 0.35));
  outerGlow.addColorStop(0, isError ? "rgba(255, 232, 224, 0.72)" : "rgba(241, 247, 255, 0.74)");
  outerGlow.addColorStop(0.32, isError ? "rgba(255, 150, 138, 0.34)" : "rgba(138, 180, 255, 0.32)");
  outerGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = outerGlow;
  context.beginPath();
  context.arc(cx, cy, radius * (1.45 + energy * 0.16), 0, TAU);
  context.fill();

  const core = context.createRadialGradient(cx - radius * 0.2, cy - radius * 0.24, radius * 0.12, cx, cy, radius);
  core.addColorStop(0, isError ? "rgba(255, 248, 244, 0.98)" : "rgba(255, 255, 255, 0.98)");
  core.addColorStop(0.4, isError ? "rgba(255, 176, 160, 0.9)" : "rgba(161, 196, 255, 0.9)");
  core.addColorStop(1, isError ? "rgba(87, 14, 32, 0.46)" : "rgba(27, 44, 126, 0.42)");
  context.fillStyle = core;
  context.beginPath();
  context.arc(cx, cy, radius, 0, TAU);
  context.fill();

  for (let index = 0; index < 5; index += 1) {
    const angle = time * (0.8 + index * 0.12) + index * 1.34;
    const pulse = 0.4 + Math.sin(time * 1.6 + index) * 0.2;
    const particleRadius = radius * (0.1 + index * 0.016) * (1 + energy * 0.2);
    const particleX = cx + Math.cos(angle) * radius * 0.36 * pulse;
    const particleY = cy + Math.sin(angle * 1.2) * radius * 0.22 * pulse;

    context.save();
    context.fillStyle = isError ? "rgba(255, 242, 238, 0.7)" : "rgba(240, 248, 255, 0.72)";
    context.shadowColor = isError ? "rgba(255, 149, 132, 0.72)" : "rgba(116, 196, 255, 0.72)";
    context.shadowBlur = 10 + energy * 8;
    context.globalAlpha = 0.48 + energy * 0.16;
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
  connectionState = "idle"
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
      const energy = clamp(smoothedLevel * 0.92 + historyAverage * 0.45 + historyPeak * 0.2, 0, 1.35);
      const baseRadius = Math.min(width, height) * (0.108 + energy * 0.02);
      const orbitRadius = Math.min(width, height) * (0.215 + energy * 0.028);
      const time = performance.now() * 0.001;
      const isError = drawState.connectionState === "error";
      const palette = isError ? ERROR_PALETTE : DEFAULT_PALETTE;

      smoothedLevelRef.current = smoothedLevel;
      context.clearRect(0, 0, width, height);

      drawAmbientBackground(context, width, height, cx, cy, orbitRadius, isError, energy);

      context.save();
      context.globalCompositeOperation = "screen";

      const orbitModels = ORBIT_SHAPES.map((orbit, orbitIndex) => createOrbitModel({
        cx,
        cy,
        history,
        orbit,
        palette: palette[orbitIndex],
        time,
        orbitIndex,
        energy,
        baseRadius: orbitRadius
      }));

      orbitModels.forEach((orbitModel) => {
        drawOrbitBack(context, orbitModel);
      });

      drawNucleus(context, cx, cy, baseRadius * (1 + energy * 0.12), energy, isError, time);

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
  }, []);

  return <canvas ref={canvasRef} className="voice-mode-panel__orb-canvas" aria-hidden="true" />;
}
