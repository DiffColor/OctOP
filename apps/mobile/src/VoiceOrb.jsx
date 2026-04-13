import { useEffect, useRef } from "react";

const TAU = Math.PI * 2;
const MIN_CANVAS_SIZE = 220;
const DEFAULT_HISTORY = Array.from({ length: 24 }, () => 0.08);

const DEFAULT_LAYERS = [
  {
    color: "#74f6ff",
    glowColor: "rgba(116, 246, 255, 0.55)",
    radiusFactor: 0.56,
    lineWidth: 1.6,
    speed: 0.48,
    direction: 1,
    phase: 0.2,
    distortion: 0.34,
    harmonics: [3, 7, 11]
  },
  {
    color: "#9d7dff",
    glowColor: "rgba(157, 125, 255, 0.48)",
    radiusFactor: 0.7,
    lineWidth: 1.9,
    speed: 0.72,
    direction: -1,
    phase: 1.35,
    distortion: 0.4,
    harmonics: [4, 9, 13]
  },
  {
    color: "#ff82d1",
    glowColor: "rgba(255, 130, 209, 0.44)",
    radiusFactor: 0.84,
    lineWidth: 2.1,
    speed: 0.61,
    direction: 1,
    phase: 2.4,
    distortion: 0.46,
    harmonics: [5, 8, 15]
  },
  {
    color: "#6ca0ff",
    glowColor: "rgba(108, 160, 255, 0.36)",
    radiusFactor: 0.99,
    lineWidth: 1.5,
    speed: 0.9,
    direction: -1,
    phase: 3.4,
    distortion: 0.52,
    harmonics: [6, 10, 17]
  }
];

const ERROR_LAYERS = [
  {
    color: "#ff9eb2",
    glowColor: "rgba(255, 158, 178, 0.52)",
    radiusFactor: 0.56,
    lineWidth: 1.6,
    speed: 0.48,
    direction: 1,
    phase: 0.2,
    distortion: 0.34,
    harmonics: [3, 7, 11]
  },
  {
    color: "#ff8b7a",
    glowColor: "rgba(255, 139, 122, 0.48)",
    radiusFactor: 0.7,
    lineWidth: 1.9,
    speed: 0.72,
    direction: -1,
    phase: 1.35,
    distortion: 0.4,
    harmonics: [4, 9, 13]
  },
  {
    color: "#ffd39a",
    glowColor: "rgba(255, 211, 154, 0.4)",
    radiusFactor: 0.84,
    lineWidth: 2.1,
    speed: 0.61,
    direction: 1,
    phase: 2.4,
    distortion: 0.46,
    harmonics: [5, 8, 15]
  },
  {
    color: "#ff7c9c",
    glowColor: "rgba(255, 124, 156, 0.34)",
    radiusFactor: 0.99,
    lineWidth: 1.5,
    speed: 0.9,
    direction: -1,
    phase: 3.4,
    distortion: 0.52,
    harmonics: [6, 10, 17]
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

function drawAmbientBackground(context, width, height, cx, cy, radius, isError, energy) {
  const base = context.createRadialGradient(cx, cy, radius * 0.12, cx, cy, Math.max(width, height) * 0.72);
  base.addColorStop(0, isError ? "rgba(86, 24, 36, 0.28)" : "rgba(30, 36, 108, 0.26)");
  base.addColorStop(0.4, isError ? "rgba(47, 8, 18, 0.18)" : "rgba(10, 12, 38, 0.16)");
  base.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = base;
  context.fillRect(0, 0, width, height);

  const bloom = context.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius * (1.9 + energy * 0.55));
  bloom.addColorStop(0, isError ? "rgba(255, 186, 168, 0.16)" : "rgba(201, 182, 255, 0.16)");
  bloom.addColorStop(0.52, isError ? "rgba(255, 122, 150, 0.08)" : "rgba(112, 153, 255, 0.08)");
  bloom.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = bloom;
  context.fillRect(0, 0, width, height);
}

function drawHalo(context, cx, cy, radius, color, alpha) {
  const halo = context.createRadialGradient(cx, cy, radius * 0.54, cx, cy, radius * 1.46);
  halo.addColorStop(0, "rgba(255, 255, 255, 0)");
  halo.addColorStop(0.45, withAlpha(color, alpha));
  halo.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = halo;
  context.fillRect(cx - radius * 1.5, cy - radius * 1.5, radius * 3, radius * 3);
}

function buildRingPath(context, {
  cx,
  cy,
  baseRadius,
  amplitude,
  history,
  layer,
  time,
  energy,
  layerIndex
}) {
  const points = 220;
  const rotation = time * layer.speed * layer.direction + layer.phase;

  context.beginPath();

  for (let index = 0; index <= points; index += 1) {
    const progress = index / points;
    const angle = progress * TAU;
    const rotatedAngle = angle + rotation;
    const historyValue = sampleHistory(history, progress + rotation * 0.05 + layerIndex * 0.09);
    const harmonicA = Math.sin(rotatedAngle * layer.harmonics[0] + time * 0.72 + layer.phase) * 0.52;
    const harmonicB = Math.cos(rotatedAngle * layer.harmonics[1] - time * 0.58 + historyValue * 3.1) * 0.31;
    const harmonicC = Math.sin(rotatedAngle * layer.harmonics[2] + time * 0.93 * layer.direction) * 0.17;
    const radiusDrift = Math.sin(angle - time * 0.35 + layer.phase) * baseRadius * 0.028 * (0.5 + energy);
    const distortion = (harmonicA + harmonicB + harmonicC) * amplitude + historyValue * amplitude * (0.48 + layerIndex * 0.06);
    const radius = baseRadius + distortion + radiusDrift;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;

    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }

  context.closePath();
}

function drawRingLayer(context, params) {
  const {
    cx,
    cy,
    baseRadius,
    energy,
    history,
    layer,
    time,
    layerIndex
  } = params;

  const amplitude = baseRadius * (0.048 + layer.distortion * 0.04) * (1 + energy * 1.9);

  buildRingPath(context, {
    cx,
    cy,
    baseRadius,
    amplitude,
    history,
    layer,
    time,
    energy,
    layerIndex
  });

  context.strokeStyle = layer.color;
  context.lineWidth = layer.lineWidth + energy * 1.4;
  context.shadowColor = layer.color;
  context.shadowBlur = 18 + energy * 30;
  context.globalAlpha = 0.34 + energy * 0.16;
  context.stroke();

  buildRingPath(context, {
    cx,
    cy,
    baseRadius,
    amplitude,
    history,
    layer,
    time,
    energy,
    layerIndex
  });

  context.lineWidth = layer.lineWidth + 0.35 + energy * 0.35;
  context.shadowBlur = 8 + energy * 14;
  context.globalAlpha = 0.94;
  context.stroke();
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
      const responseBoost = drawState.isResponding ? 0.22 : 0;
      const listeningBoost = drawState.isListening ? 0.1 : 0;
      const targetLevel = clamp(Number(drawState.audioLevel) + responseBoost + listeningBoost, 0, 1.25);
      const smoothedLevel = smoothedLevelRef.current + (targetLevel - smoothedLevelRef.current) * 0.16;
      const energy = clamp(smoothedLevel * 0.95 + historyAverage * 0.45 + historyPeak * 0.2, 0, 1.35);
      const baseRadius = Math.min(width, height) * (0.18 + energy * 0.018);
      const scale = 1 + energy * 0.16;
      const layers = drawState.connectionState === "error" ? ERROR_LAYERS : DEFAULT_LAYERS;
      const time = performance.now() * 0.00105;
      const isError = drawState.connectionState === "error";

      smoothedLevelRef.current = smoothedLevel;
      context.clearRect(0, 0, width, height);

      drawAmbientBackground(context, width, height, cx, cy, baseRadius * scale, isError, energy);

      context.save();
      context.globalCompositeOperation = "screen";

      layers.forEach((layer, layerIndex) => {
        const layerRadius = baseRadius * layer.radiusFactor * scale * (1 + historyAverage * 0.12);
        drawHalo(context, cx, cy, layerRadius * (1.12 + energy * 0.08), layer.glowColor, 0.12 + layerIndex * 0.025 + energy * 0.05);
        drawRingLayer(context, {
          cx,
          cy,
          baseRadius: layerRadius,
          energy,
          history,
          layer,
          time,
          layerIndex
        });
      });

      const coreGlow = context.createRadialGradient(cx, cy, baseRadius * 0.08, cx, cy, baseRadius * (0.85 + energy * 0.3));
      coreGlow.addColorStop(0, isError ? "rgba(255, 241, 231, 0.58)" : "rgba(242, 247, 255, 0.58)");
      coreGlow.addColorStop(0.34, isError ? "rgba(255, 164, 146, 0.22)" : "rgba(174, 196, 255, 0.18)");
      coreGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
      context.fillStyle = coreGlow;
      context.beginPath();
      context.arc(cx, cy, baseRadius * (0.95 + energy * 0.18), 0, TAU);
      context.fill();

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
