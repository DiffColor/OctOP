import { useEffect, useRef } from "react";

const MIN_CANVAS_SIZE = 180;
const DEFAULT_HISTORY = Array.from({ length: 24 }, () => 0.08);

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

  const scaledIndex = clamp(normalizedIndex, 0, 1) * (history.length - 1);
  const lowerIndex = Math.floor(scaledIndex);
  const upperIndex = Math.min(history.length - 1, lowerIndex + 1);
  const ratio = scaledIndex - lowerIndex;

  return history[lowerIndex] * (1 - ratio) + history[upperIndex] * ratio;
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
      const prevSize = sizeRef.current;

      if (prevSize.width !== nextWidth || prevSize.height !== nextHeight || prevSize.dpr !== nextDpr) {
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
      const cy = height * 0.44;
      const orbRadius = Math.min(width * 0.26, height * 0.31);
      const drawState = drawStateRef.current;
      const history = resolveHistory(drawState.levelHistory);
      const energyBoost = (drawState.isResponding ? 0.28 : 0) + (drawState.isListening ? 0.12 : 0);
      const targetLevel = clamp(Number(drawState.audioLevel) + energyBoost, 0, 1.2);
      const previousLevel = smoothedLevelRef.current;
      const level = previousLevel + (targetLevel - previousLevel) * 0.18;
      const time = performance.now() * 0.0038;
      const isError = drawState.connectionState === "error";
      const ringColor = isError ? "#ff8da1" : "#cfd4ff";
      const ringGlow = isError ? "#ff5e7a" : "#7e89ff";
      const floorColor = isError ? "#ff7a92" : "#63f3ff";

      smoothedLevelRef.current = level;
      context.clearRect(0, 0, width, height);

      const ambient = context.createRadialGradient(cx, cy, 20, cx, cy, Math.max(width, height) * 0.68);
      ambient.addColorStop(0, isError ? "rgba(58, 14, 22, 0.88)" : "rgba(15, 31, 90, 0.82)");
      ambient.addColorStop(0.52, isError ? "rgba(24, 7, 14, 0.32)" : "rgba(8, 14, 40, 0.2)");
      ambient.addColorStop(1, "rgba(0, 0, 0, 0)");
      context.fillStyle = ambient;
      context.fillRect(0, 0, width, height);

      context.save();
      context.globalAlpha = 0.28 + level * 0.42;
      const floorY = cy + orbRadius + Math.min(height * 0.18, 74);
      const floorGlow = context.createRadialGradient(cx, floorY, 12, cx, floorY, 120 + level * 70);
      floorGlow.addColorStop(0, floorColor);
      floorGlow.addColorStop(1, "transparent");
      context.fillStyle = floorGlow;
      context.beginPath();
      context.ellipse(cx, floorY, Math.min(width * 0.28, 172), Math.min(height * 0.085, 48), 0, 0, Math.PI * 2);
      context.fill();
      context.restore();

      context.save();
      context.beginPath();
      context.arc(cx, cy, orbRadius, 0, Math.PI * 2);
      context.clip();

      const orbFill = context.createRadialGradient(cx - orbRadius * 0.2, cy - orbRadius * 0.24, 10, cx, cy, orbRadius);
      orbFill.addColorStop(0, isError ? "#73203b" : "#1a2f7b");
      orbFill.addColorStop(1, isError ? "#220612" : "#0a1030");
      context.fillStyle = orbFill;
      context.fillRect(cx - orbRadius, cy - orbRadius, orbRadius * 2, orbRadius * 2);

      const drawWave = (color, phase, amplitudeMultiplier, yOffset, lineWidth) => {
        context.strokeStyle = color;
        context.lineWidth = lineWidth;
        context.shadowColor = color;
        context.shadowBlur = 16;
        context.beginPath();

        const waveWidth = orbRadius * 1.78;
        const startX = cx - waveWidth / 2;
        const endX = cx + waveWidth / 2;
        const step = Math.max(1.5, waveWidth / 96);

        for (let x = startX; x <= endX; x += step) {
          const nx = (x - startX) / waveWidth;
          const historyLevel = sampleHistory(history, nx);
          const syntheticBin = clamp(
            historyLevel * 0.88 + Math.sin(nx * Math.PI * 8 + phase * 0.95) * 0.12 + level * 0.52,
            0,
            1
          );
          const amplitude = (10 + level * 54) * (0.22 + syntheticBin * 0.78) * amplitudeMultiplier;
          const y = cy + yOffset + Math.sin(nx * Math.PI * 10 + phase) * amplitude;

          if (x === startX) {
            context.moveTo(x, y);
          } else {
            context.lineTo(x, y);
          }
        }

        context.stroke();
        context.shadowBlur = 0;
      };

      drawWave(isError ? "#ff9cb0" : "#62f5ff", time * 1.45, 1, 0, 2.2);
      drawWave(isError ? "#ffc0cf" : "#b68aff", time * 1.82 + 0.9, 0.82, -3, 2);
      drawWave(isError ? "#ffd3dc" : "#8efbff", time * 1.12 + 2.1, 0.62, 2, 1.8);

      context.globalAlpha = 0.34;
      const highlight = context.createLinearGradient(cx - orbRadius * 0.5, cy - orbRadius * 0.9, cx + orbRadius * 0.2, cy);
      highlight.addColorStop(0, "#ffffff");
      highlight.addColorStop(1, "transparent");
      context.fillStyle = highlight;
      context.beginPath();
      context.ellipse(cx - orbRadius * 0.25, cy - orbRadius * 0.42, orbRadius * 0.34, orbRadius * 0.16, -0.25, 0, Math.PI * 2);
      context.fill();
      context.restore();

      context.save();
      context.strokeStyle = ringColor;
      context.lineWidth = 2;
      context.shadowColor = ringGlow;
      context.shadowBlur = 22 + level * 20;
      context.beginPath();
      context.arc(cx, cy, orbRadius, 0, Math.PI * 2);
      context.stroke();
      context.restore();

      context.save();
      context.globalAlpha = 0.22 + level * 0.18;
      context.strokeStyle = isError ? "rgba(255, 171, 186, 0.38)" : "rgba(144, 206, 255, 0.32)";
      context.lineWidth = 1;
      context.beginPath();
      context.arc(cx, cy, orbRadius + 18 + level * 10, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.arc(cx, cy, orbRadius + 34 + level * 18, 0, Math.PI * 2);
      context.stroke();
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
