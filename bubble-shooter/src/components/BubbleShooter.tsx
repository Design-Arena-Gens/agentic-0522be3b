"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  BUBBLE_COLORS,
  LEVELS,
  type LevelConfig,
  type SpecialBubble,
} from "@/constants/levels";
import {
  GAME_METRICS,
  GRID_COLS,
  MAX_ROWS,
  clamp,
  computeAimGuideLength,
  computeMatchResult,
  dropNewRow,
  generateInitialGrid,
  generateShooterBubble,
  gridCleared,
  gridReachedFailureLine,
  levelByIndex,
  placeBubbleOnGrid,
} from "@/lib/gameUtils";
import type {
  ActiveBubble,
  Grid,
  LevelRuntimeState,
  ShooterBubbleCandidate,
} from "@/lib/gameTypes";

type StarTrack = {
  level: number;
  stars: number;
  score: number;
};

interface VisualEffect {
  id: number;
  x: number;
  y: number;
  radius: number;
  color: string;
  createdAt: number;
  duration: number;
}

const MAX_COMBO_MULTIPLIER = 8;

const createAudioContext = () => {
  if (typeof window === "undefined") return null;
  const ctx = new AudioContext();
  return ctx;
};

const playPop = (
  audioCtx: AudioContext | null,
  popCount: number,
  combo: number,
) => {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  const baseFreq = 220 + popCount * 25 + combo * 15;
  osc.frequency.setValueAtTime(baseFreq, now);
  osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.4, now + 0.15);

  gain.gain.setValueAtTime(0.18, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);

  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.3);
};

const playFail = (audioCtx: AudioContext | null) => {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(180, now);
  osc.frequency.linearRampToValueAtTime(80, now + 0.6);
  gain.gain.setValueAtTime(0.18, now);
  gain.gain.linearRampToValueAtTime(0.0001, now + 0.65);

  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.7);
};

const aimAngleConstraints = {
  min: (-4 * Math.PI) / 5,
  max: (-1 * Math.PI) / 8,
};

const computeShotSpeed = (level: LevelConfig) =>
  520 + Math.min(level.level * 16, 220);

const computeStarRating = (
  score: number,
  shots: number,
  livesLeft: number,
  level: LevelConfig,
) => {
  const accuracy = score / Math.max(shots, 1);
  const difficultyModifier =
    level.difficulty === "Easy"
      ? 0.9
      : level.difficulty === "Medium"
      ? 1
      : level.difficulty === "Hard"
      ? 1.18
      : level.difficulty === "Very Hard"
      ? 1.3
      : 1.42;
  const scoreNorm = score * difficultyModifier + livesLeft * 400;
  const thresholds = [
    3000 + level.level * 160,
    5500 + level.level * 260,
    8000 + level.level * 340,
  ];

  if (scoreNorm >= thresholds[2] && accuracy > 120) return 3;
  if (scoreNorm >= thresholds[1] && accuracy > 95) return 2;
  if (scoreNorm >= thresholds[0]) return 1;
  return 0;
};

const formatTime = (seconds: number | undefined) => {
  if (seconds === undefined) return "";
  const clamped = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(clamped / 60)
    .toString()
    .padStart(2, "0");
  const secs = (clamped % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
};

const BubbleShooter = () => {
  const [levelIndex, setLevelIndex] = useState(0);
  const activeLevel = levelByIndex(levelIndex);
  const [hud, setHud] = useState<LevelRuntimeState>(() => ({
    level: activeLevel,
    score: 0,
    combo: 1,
    lives: 3,
    cleared: false,
    timeLeft: activeLevel.timeLimitSeconds,
    lastDropAt: performance.now(),
  }));

  const runtimeRef = useRef<LevelRuntimeState>(hud);
  const gridRef = useRef<Grid>(generateInitialGrid(activeLevel));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const activeBubbleRef = useRef<ActiveBubble | null>(null);
  const aimAngleRef = useRef(-Math.PI / 2);
  const aimStrengthRef = useRef(1);
  const pointerLockedRef = useRef(false);
  const nextQueueRef = useRef<ShooterBubbleCandidate[]>([
    generateShooterBubble(activeLevel),
    generateShooterBubble(activeLevel),
  ]);
  const [nextQueueState, setNextQueueState] = useState<
    ShooterBubbleCandidate[]
  >(nextQueueRef.current);
  const audioRef = useRef<AudioContext | null>(null);
  const [effects, setEffects] = useState<VisualEffect[]>([]);
  const effectRef = useRef<VisualEffect[]>([]);
  const [stars, setStars] = useState<StarTrack[]>([]);
  const [shotsTaken, setShotsTaken] = useState(0);
  const shotsRef = useRef(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isGameOver, setIsGameOver] = useState(false);
  const [dynamicLight, setDynamicLight] = useState(0);
  const [gridVersion, setGridVersion] = useState(0);
  const rowOffsetRef = useRef<number[]>(Array(MAX_ROWS).fill(0));
  const lastFrameRef = useRef<number | null>(null);
  const freezeUntilRef = useRef<number | undefined>(undefined);
  const aimBoostUntilRef = useRef<number | undefined>(undefined);

  const resetLevelState = useCallback(
    (level: LevelConfig) => {
      runtimeRef.current = {
        level,
        score: levelIndex === 0 ? 0 : runtimeRef.current.score,
        combo: 1,
        lives: 3,
        cleared: false,
        timeLeft: level.timeLimitSeconds,
        lastDropAt: performance.now(),
      };
      freezeUntilRef.current = undefined;
      aimBoostUntilRef.current = undefined;
      setHud({ ...runtimeRef.current });
      gridRef.current = generateInitialGrid(level);
      setGridVersion((prev) => prev + 1);
      activeBubbleRef.current = null;
      aimAngleRef.current = -Math.PI / 2;
      aimStrengthRef.current = 1;
      rowOffsetRef.current = Array(MAX_ROWS).fill(0);
      nextQueueRef.current = [
        generateShooterBubble(level),
        generateShooterBubble(level),
      ];
      setNextQueueState([...nextQueueRef.current]);
      shotsRef.current = 0;
      setShotsTaken(0);
      setStatusMessage(null);
      setDynamicLight(0);
      lastFrameRef.current = null;
      effectRef.current = [];
      setEffects([]);
    },
    [levelIndex],
  );

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = createAudioContext();
    } else if (audioRef.current.state === "suspended") {
      audioRef.current.resume().catch(() => {});
    }
  }, []);

  const activateNextBubble = useCallback(() => {
    const [current, ...rest] = nextQueueRef.current;
    const next = rest.length > 0 ? rest : [generateShooterBubble(activeLevel)];
    nextQueueRef.current = [...next, generateShooterBubble(activeLevel)];
    setNextQueueState(nextQueueRef.current.slice(0, 2));
    return current;
  }, [activeLevel]);

  const addEffect = useCallback((effect: VisualEffect) => {
    effectRef.current = [...effectRef.current, effect];
    setEffects(effectRef.current);
  }, []);

  const syncHud = useCallback(() => {
    setHud({ ...runtimeRef.current });
  }, []);

  const handleMatchResults = useCallback(
    (removedCount: number, comboBonus: number) => {
      const runtime = runtimeRef.current;
      if (removedCount > 0) {
        runtime.combo = clamp(runtime.combo + 1, 1, MAX_COMBO_MULTIPLIER);
        const gained =
          removedCount * 80 +
          comboBonus * runtime.combo * 10 +
          (removedCount >= 6 ? 150 : 0);
        runtime.score += gained;
      } else {
        runtime.combo = 1;
      }
      runtimeRef.current = { ...runtime };
      syncHud();
    },
    [syncHud],
  );

  const triggerSpecialEffect = useCallback(
    (type: SpecialBubble | "normal" | "obstacle") => {
      if (type === "obstacle" || type === "normal") return;
      if (type === "freeze") {
        freezeUntilRef.current = performance.now() + 5000;
        setStatusMessage("Freeze bubble activated! Descent slowed.");
      }
      if (type === "aim") {
        aimBoostUntilRef.current = performance.now() + 7000;
        setStatusMessage("Aim boost active!");
      }
    },
    [],
  );

  const resolveLanding = useCallback(
    (bubble: ActiveBubble) => {
      const level = runtimeRef.current.level;
      const { grid, row, col } = placeBubbleOnGrid(gridRef.current, bubble);
      gridRef.current = grid;
      const match = computeMatchResult(gridRef.current, row, col);

      if (match.removed.length > 0) {
        addEffect({
          id: Date.now() + Math.random(),
          x: bubble.x,
          y: bubble.y,
          radius: 10 + match.removed.length * 2,
          color: bubble.color,
          createdAt: performance.now(),
          duration: 420,
        });
        ensureAudio();
        playPop(audioRef.current, match.removed.length, runtimeRef.current.combo);
      }

      handleMatchResults(match.removed.length + match.floating.length, match.comboBonus);

      match.triggeredSpecials.forEach((cell) => triggerSpecialEffect(cell.type));

      if (gridCleared(gridRef.current)) {
        const runtime = runtimeRef.current;
        runtime.cleared = true;
        const starRating = computeStarRating(
          runtime.score,
          shotsRef.current,
          runtime.lives,
          level,
        );
        setStars((prev) => [
          ...prev.filter((entry) => entry.level !== level.level),
          { level: level.level, stars: starRating, score: runtime.score },
        ]);
        setStatusMessage(
          `Level ${level.level} cleared! ⭐${"⭐".repeat(starRating)}`,
        );
        runtimeRef.current = { ...runtime };
        syncHud();
      }
      setGridVersion((prev) => prev + 1);
    },
    [
      addEffect,
      ensureAudio,
      handleMatchResults,
      syncHud,
      triggerSpecialEffect,
    ],
  );

  const performShoot = useCallback(() => {
    if (runtimeRef.current.cleared || runtimeRef.current.lives <= 0) return;
    if (activeBubbleRef.current) return;

    const shooter = activateNextBubble();
    const speed = computeShotSpeed(runtimeRef.current.level);
    activeBubbleRef.current = {
      id: Date.now(),
      color: shooter.color,
      type: shooter.type,
      x: GAME_METRICS.width / 2,
      y: GAME_METRICS.shooterY - GAME_METRICS.bubbleRadius - 4,
      dx: Math.cos(aimAngleRef.current),
      dy: Math.sin(aimAngleRef.current),
      speed,
      launchedAt: performance.now(),
    };
    if (shooter.type !== "normal") {
      triggerSpecialEffect(shooter.type);
    }
    shotsRef.current += 1;
    setShotsTaken(shotsRef.current);
  }, [activateNextBubble, triggerSpecialEffect]);

  const loseLife = useCallback(() => {
    const runtime = runtimeRef.current;
    runtime.lives -= 1;
    runtime.combo = 1;
    runtimeRef.current = { ...runtime };
    ensureAudio();
    playFail(audioRef.current);
    setStatusMessage("Bubble wall reached the cannon! Life lost.");
    syncHud();
    gridRef.current = generateInitialGrid(runtime.level);
    activeBubbleRef.current = null;
    setGridVersion((prev) => prev + 1);

    if (runtime.lives <= 0) {
      runtimeRef.current = { ...runtime, cleared: false };
      setIsGameOver(true);
    }
  }, [ensureAudio, syncHud]);

  const dropCycle = useCallback(
    (timestamp: number) => {
      const runtime = runtimeRef.current;
      const level = runtime.level;
      const frozen = freezeUntilRef.current && freezeUntilRef.current > timestamp;
      const interval = frozen ? level.descentInterval * 1.65 : level.descentInterval;
      if (timestamp - runtime.lastDropAt >= interval) {
        dropNewRow(gridRef.current, level);
        runtime.lastDropAt = timestamp;
        runtimeRef.current = { ...runtime };
        syncHud();
        setGridVersion((prev) => prev + 1);
        if (gridReachedFailureLine(gridRef.current)) {
          loseLife();
        }
      }
    },
    [loseLife, syncHud],
  );

  const applyTimeLimit = useCallback(
    (delta: number) => {
      if (runtimeRef.current.level.timeLimitSeconds === undefined) return;
      const runtime = runtimeRef.current;
      const remaining = (runtime.timeLeft ?? 0) - delta / 1000;
      runtime.timeLeft = remaining;
      if (remaining <= 0) {
        runtime.timeLeft = 0;
        loseLife();
        runtime.lastDropAt = performance.now();
      }
      runtimeRef.current = { ...runtime };
      setHud({ ...runtime });
    },
    [loseLife],
  );

  const updateMovingRows = useCallback(
    (timestamp: number) => {
      const level = runtimeRef.current.level;
      if (!level.movingRows || !level.movingRows.length) return;
      const amplitude = level.movingAmplitude ?? 20;
      const speed = level.movingSpeed ?? 1;

      for (const row of level.movingRows) {
        const offset =
          Math.sin(timestamp / (900 / speed) + row) * amplitude * (row % 2 === 0 ? 1 : -1);
        rowOffsetRef.current[row] = offset;
      }
    },
    [],
  );

  const updateActiveBubble = useCallback(
    (deltaMs: number) => {
      const bubble = activeBubbleRef.current;
      if (!bubble) return;

      const deltaSeconds = deltaMs / 1000;
      bubble.x += bubble.dx * bubble.speed * deltaSeconds;
      bubble.y += bubble.dy * bubble.speed * deltaSeconds;

      if (
        bubble.x <= GAME_METRICS.bubbleRadius + 24 ||
        bubble.x >= GAME_METRICS.width - (GAME_METRICS.bubbleRadius + 24)
      ) {
        bubble.dx *= -1;
        bubble.x = clamp(
          bubble.x,
          GAME_METRICS.bubbleRadius + 24,
          GAME_METRICS.width - (GAME_METRICS.bubbleRadius + 24),
        );
      }

      if (bubble.y <= GAME_METRICS.topMargin + GAME_METRICS.bubbleRadius / 2) {
        resolveLanding(bubble);
        activeBubbleRef.current = null;
        return;
      }

      for (let row = 0; row < gridRef.current.length; row++) {
        for (let col = 0; col < GRID_COLS; col++) {
          const cell = gridRef.current[row]?.[col];
          if (!cell || cell.type === "obstacle") continue;
          const offset = rowOffsetRef.current[row] ?? 0;
          const cx = cell.x + offset;
          const dx = bubble.x - cx;
          const dy = bubble.y - cell.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist <= GAME_METRICS.bubbleRadius * 2 - 2) {
            resolveLanding(bubble);
            activeBubbleRef.current = null;
            return;
          }
        }
      }
    },
    [resolveLanding],
  );

  const pruneEffects = useCallback(() => {
    const now = performance.now();
    const filtered = effectRef.current.filter(
      (fx) => now - fx.createdAt < fx.duration,
    );
    if (filtered.length !== effectRef.current.length) {
      effectRef.current = filtered;
      setEffects(filtered);
    }
  }, []);

  const drawScene = useCallback(
    (timestamp: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const level = runtimeRef.current.level;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
      const lightFactor =
        level.level >= 18
          ? 0.5 + 0.5 * Math.sin(timestamp / 700 + dynamicLight / 8)
          : 0.4;
      gradient.addColorStop(
        0,
        `rgba(${Math.floor(30 + 80 * lightFactor)}, ${Math.floor(
          40 + 100 * lightFactor,
        )}, ${Math.floor(70 + 80 * lightFactor)}, 1)`,
      );
      gradient.addColorStop(
        1,
        `rgba(${Math.floor(70 + 120 * lightFactor)}, ${Math.floor(
          70 + 120 * lightFactor,
        )}, ${Math.floor(110 + 110 * lightFactor)}, 1)`,
      );
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
      ctx.fillRect(0, GAME_METRICS.shooterY + 12, canvas.width, 8);

      for (let row = 0; row < gridRef.current.length; row++) {
        for (let col = 0; col < GRID_COLS; col++) {
          const cell = gridRef.current[row]?.[col];
          if (!cell) continue;
          const offset = rowOffsetRef.current[row] ?? 0;
          const cx = cell.x + offset;
          const radius =
            cell.type === "obstacle"
              ? GAME_METRICS.bubbleRadius * 0.92
              : GAME_METRICS.bubbleRadius;
          ctx.beginPath();
          ctx.fillStyle = cell.color;
          ctx.strokeStyle =
            cell.type === "obstacle"
              ? "#3f4859"
              : Object.values(BUBBLE_COLORS).find(
                  (entry) => entry.fill === cell.color,
                )?.border ?? "#1f1f1f";
          ctx.lineWidth = cell.type === "obstacle" ? 4 : 3;
          ctx.arc(cx, cell.y, radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          if (cell.type !== "normal" && cell.type !== "obstacle") {
            ctx.fillStyle = "rgba(255,255,255,0.8)";
            ctx.font = `${radius}px 'Trebuchet MS', sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            const symbol =
              cell.type === "bomb"
                ? "💥"
                : cell.type === "rainbow"
                ? "✨"
                : cell.type === "freeze"
                ? "❄️"
                : "🎯";
            ctx.fillText(symbol, cx, cell.y);
          }
        }
      }

      const aimBoostActive =
        aimBoostUntilRef.current && aimBoostUntilRef.current > timestamp;
      const guideLength = computeAimGuideLength(level, Boolean(aimBoostActive));
      const aimX = GAME_METRICS.width / 2;
      const aimY = GAME_METRICS.shooterY - GAME_METRICS.bubbleRadius;
      ctx.setLineDash([10, 12]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.moveTo(aimX, aimY);
      ctx.lineTo(
        aimX + Math.cos(aimAngleRef.current) * guideLength,
        aimY + Math.sin(aimAngleRef.current) * guideLength,
      );
      ctx.stroke();
      ctx.setLineDash([]);

      const activeBubble = activeBubbleRef.current;
      const shooter =
        activeBubble ??
        ({
          x: aimX,
          y: aimY,
          color: nextQueueState[0]?.color ?? BUBBLE_COLORS.red.fill,
          type: nextQueueState[0]?.type ?? "normal",
        } as ActiveBubble);
      ctx.beginPath();
      ctx.fillStyle = shooter.color;
      ctx.strokeStyle =
        Object.values(BUBBLE_COLORS).find(
          (entry) => entry.fill === shooter.color,
        )?.border ?? "#212121";
      ctx.lineWidth = 4;
      ctx.arc(
        activeBubble ? activeBubble.x : aimX,
        activeBubble ? activeBubble.y : aimY,
        GAME_METRICS.bubbleRadius,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.stroke();

      if (shooter.type !== "normal") {
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.font = `${GAME_METRICS.bubbleRadius}px 'Trebuchet MS', sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const symbol =
          shooter.type === "bomb"
            ? "💣"
            : shooter.type === "freeze"
            ? "🧊"
            : shooter.type === "aim"
            ? "🎯"
            : "🌈";
        ctx.fillText(
          symbol,
          activeBubble ? activeBubble.x : aimX,
          activeBubble ? activeBubble.y : aimY,
        );
      }

      nextQueueState.slice(0, 2).forEach((bubble, idx) => {
        const previewX = 90;
        const previewY = GAME_METRICS.shooterY - idx * 70;
        ctx.beginPath();
        ctx.fillStyle = bubble.color;
        ctx.strokeStyle =
          Object.values(BUBBLE_COLORS).find(
            (entry) => entry.fill === bubble.color,
          )?.border ?? "#2f2f2f";
        ctx.arc(previewX, previewY, GAME_METRICS.bubbleRadius * 0.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });

      for (const fx of effects) {
        const progress = (timestamp - fx.createdAt) / fx.duration;
        if (progress > 1) continue;
        ctx.beginPath();
        ctx.strokeStyle = fx.color;
        ctx.globalAlpha = 1 - progress;
        ctx.lineWidth = 6 * (1 - progress);
        ctx.arc(
          fx.x,
          fx.y,
          fx.radius + Math.sin(progress * Math.PI) * GAME_METRICS.bubbleRadius,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    },
    [dynamicLight, effects, nextQueueState],
  );

  const animationLoop = useCallback(
    function loop(timestamp: number) {
      if (!lastFrameRef.current) {
        lastFrameRef.current = timestamp;
      }
      const delta = timestamp - (lastFrameRef.current ?? timestamp);
      lastFrameRef.current = timestamp;

      dropCycle(timestamp);
      updateActiveBubble(delta);
      pruneEffects();
      updateMovingRows(timestamp);
      drawScene(timestamp);

      if (runtimeRef.current.level.timeLimitSeconds !== undefined) {
        applyTimeLimit(delta);
      }

      if (runtimeRef.current.level.endless) {
        setDynamicLight((prev) => prev + 0.015 * delta);
      }

      animationFrameRef.current = requestAnimationFrame(loop);
    },
    [
      applyTimeLimit,
      drawScene,
      dropCycle,
      pruneEffects,
      updateActiveBubble,
      updateMovingRows,
    ],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = GAME_METRICS.width;
    canvas.height = GAME_METRICS.height;

    const handlePointerMove = (event: PointerEvent) => {
      if (!canvasRef.current) return;
      if (!pointerLockedRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const dx = x - GAME_METRICS.width / 2;
      const dy = y - (GAME_METRICS.shooterY - GAME_METRICS.bubbleRadius);
      let angle = Math.atan2(dy, dx);
      angle = clamp(angle, aimAngleConstraints.min, aimAngleConstraints.max);
      aimAngleRef.current = angle;
      aimStrengthRef.current = clamp(
        1 - Math.min(Math.abs(dx) / (GAME_METRICS.width / 2), 0.85),
        0.45,
        1,
      );
    };

    const handlePointerDown = () => {
      pointerLockedRef.current = true;
      ensureAudio();
      performShoot();
    };

    const handlePointerUp = () => {
      pointerLockedRef.current = false;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        ensureAudio();
        performShoot();
      }
      if (event.code === "ArrowLeft") {
        aimAngleRef.current = clamp(
          aimAngleRef.current - 0.08,
          aimAngleConstraints.min,
          aimAngleConstraints.max,
        );
      }
      if (event.code === "ArrowRight") {
        aimAngleRef.current = clamp(
          aimAngleRef.current + 0.08,
          aimAngleConstraints.min,
          aimAngleConstraints.max,
        );
      }
    };

    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [performShoot, ensureAudio]);

  useEffect(() => {
    animationFrameRef.current = requestAnimationFrame(animationLoop);
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [animationLoop, gridVersion]);

  const canGoNextLevel = hud.cleared && levelIndex < LEVELS.length - 1;

  const handleAdvanceLevel = useCallback(() => {
    const nextIndex = Math.min(levelIndex + 1, LEVELS.length - 1);
    setLevelIndex(nextIndex);
    const level = levelByIndex(nextIndex);
    resetLevelState(level);
  }, [levelIndex, resetLevelState]);

  const handleRestartLevel = useCallback(() => {
    resetLevelState(levelByIndex(levelIndex));
    setIsGameOver(false);
  }, [levelIndex, resetLevelState]);

  const handleRestartGame = useCallback(() => {
    setLevelIndex(0);
    resetLevelState(levelByIndex(0));
    setStars([]);
    setIsGameOver(false);
  }, [resetLevelState]);

  useEffect(() => {
    resetLevelState(levelByIndex(levelIndex));
  }, [levelIndex, resetLevelState]);

  const starSummary = useMemo(
    () =>
      stars.reduce(
        (acc, entry) => {
          acc.earned += entry.stars;
          acc.total += 3;
          return acc;
        },
        { earned: 0, total: Math.min(LEVELS.length, levelIndex + 1) * 3 },
      ),
    [levelIndex, stars],
  );

  const currentLevelStars = useMemo(
    () => stars.find((entry) => entry.level === hud.level.level)?.stars ?? 0,
    [hud.level.level, stars],
  );

  const frameNow = lastFrameRef.current ?? -Infinity;
  const activeAimBoost =
    aimBoostUntilRef.current !== undefined &&
    aimBoostUntilRef.current > frameNow;
  const activeFreeze =
    freezeUntilRef.current !== undefined &&
    freezeUntilRef.current > frameNow;

  return (
    <div className="flex min-h-screen flex-col items-center bg-gradient-to-b from-slate-900 via-slate-950 to-gray-950 py-8 text-white">
      <div className="mb-6 flex w-full max-w-5xl flex-wrap items-center justify-between gap-4 px-4">
        <div>
          <div className="text-sm uppercase tracking-widest text-slate-300">
            Level {hud.level.level} · {hud.level.difficulty}
          </div>
          <h1 className="text-3xl font-semibold text-white">
            Color Burst: 20-Level Bubble Shooter
          </h1>
          <p className="text-sm text-slate-300">
            Match vibrant bubbles, chain combos, and master 20 handcrafted
            challenges.
          </p>
        </div>
        <div className="flex items-center gap-4 rounded-2xl bg-slate-800/60 px-6 py-3 shadow-lg shadow-slate-950/30">
          <div className="text-center">
            <div className="text-xs uppercase text-slate-300">Score</div>
            <div className="text-xl font-bold tabular-nums">
              {hud.score.toLocaleString()}
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs uppercase text-slate-300">Combo</div>
            <div className="text-xl font-bold">x{hud.combo}</div>
          </div>
          <div className="text-center">
            <div className="text-xs uppercase text-slate-300">Lives</div>
            <div className="text-xl font-bold">{hud.lives}</div>
          </div>
          {hud.level.timeLimitSeconds !== undefined && (
            <div className="text-center">
              <div className="text-xs uppercase text-slate-300">Timer</div>
              <div className="text-xl font-bold">
                {formatTime(hud.timeLeft)}
              </div>
            </div>
          )}
          <div className="text-center">
            <div className="text-xs uppercase text-slate-300">Shots</div>
            <div className="text-xl font-bold">{shotsTaken}</div>
          </div>
        </div>
      </div>

      <div className="flex w-full max-w-5xl flex-col items-center gap-6 px-4 lg:flex-row">
        <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-slate-900/70 p-3 shadow-2xl shadow-slate-900/70 backdrop-blur">
          <canvas
            ref={canvasRef}
            className="h-[640px] w-[512px] cursor-crosshair rounded-2xl border border-slate-700/40 bg-slate-900/70"
          />
          {hud.cleared && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 backdrop-blur">
              <h2 className="text-3xl font-bold">
                Level {hud.level.level} Complete!
              </h2>
              <div className="mt-2 flex gap-2 text-2xl">
                {Array.from({ length: 3 }).map((_, idx) => (
                  <span
                    key={`star-${idx}`}
                    className={
                      idx < currentLevelStars
                        ? "text-yellow-300"
                        : "text-slate-500"
                    }
                  >
                    ★
                  </span>
                ))}
              </div>
              {canGoNextLevel ? (
                <button
                  onClick={handleAdvanceLevel}
                  className="mt-4 rounded-full bg-emerald-500 px-6 py-2 font-semibold text-slate-900 transition hover:bg-emerald-400"
                >
                  Continue to Level {hud.level.level + 1}
                </button>
              ) : (
                <button
                  onClick={handleRestartGame}
                  className="mt-4 rounded-full bg-cyan-500 px-6 py-2 font-semibold text-slate-900 transition hover:bg-cyan-400"
                >
                  Restart Journey
                </button>
              )}
            </div>
          )}
          {isGameOver && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 backdrop-blur">
              <h2 className="text-4xl font-semibold text-red-300">Game Over</h2>
              <p className="mt-2 text-sm text-slate-200">
                The bubble storm overwhelmed the launcher. Try again!
              </p>
              <div className="mt-4 flex gap-3">
                <button
                  onClick={handleRestartLevel}
                  className="rounded-full bg-slate-200 px-5 py-2 text-sm font-semibold text-slate-900 transition hover:bg-white"
                >
                  Retry Level
                </button>
                <button
                  onClick={handleRestartGame}
                  className="rounded-full bg-emerald-500 px-5 py-2 text-sm font-semibold text-slate-900 transition hover:bg-emerald-400"
                >
                  Restart Campaign
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex w-full flex-1 flex-col gap-4 rounded-3xl border border-white/10 bg-slate-900/60 p-6 shadow-2xl shadow-slate-900/70 backdrop-blur">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-white">Progression</h2>
            <div className="text-sm text-slate-300">
              Stars: {starSummary.earned}/{starSummary.total}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
            {LEVELS.slice(0, levelIndex + 1).map((lvl) => {
              const starData = stars.find((entry) => entry.level === lvl.level);
              return (
                <div
                  key={lvl.level}
                  className={`rounded-2xl border px-3 py-3 transition ${
                    lvl.level === hud.level.level
                      ? "border-emerald-500/70 bg-emerald-500/10"
                      : "border-white/10 bg-white/5"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs uppercase tracking-wide text-slate-300">
                      Level {lvl.level}
                    </span>
                    <span className="text-[13px] text-slate-400">
                      {lvl.difficulty}
                    </span>
                  </div>
                  <div className="mt-1 flex gap-1 text-lg">
                    {Array.from({ length: 3 }).map((_, idx) => (
                      <span
                        key={`${lvl.level}-star-${idx}`}
                        className={
                          starData && idx < starData.stars
                            ? "text-yellow-300"
                            : "text-slate-600"
                        }
                      >
                        ★
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 text-[11px] text-slate-400">
                    Colors: {lvl.colors.length} · Descent:{" "}
                    {(lvl.descentInterval / 1000).toFixed(1)}s
                  </div>
                </div>
              );
            })}
          </div>
          <div className="rounded-2xl border border-white/5 bg-black/30 p-4 text-sm text-slate-200">
            <div className="font-semibold text-white">Level Modifiers</div>
            <ul className="mt-2 space-y-1">
              <li>Available Colors: {hud.level.colors.length}</li>
              <li>
                Special Chance:{" "}
                {[
                  hud.level.bombChance && `Bomb ${Math.round(hud.level.bombChance * 100)}%`,
                  hud.level.rainbowChance &&
                    `Rainbow ${Math.round(hud.level.rainbowChance * 100)}%`,
                  hud.level.freezeChance &&
                    `Freeze ${Math.round(hud.level.freezeChance * 100)}%`,
                  hud.level.aimChance &&
                    `Aim ${Math.round(hud.level.aimChance * 100)}%`,
                ]
                  .filter(Boolean)
                  .join(" · ") || "None"}
              </li>
              <li>
                Descent Interval: {(hud.level.descentInterval / 1000).toFixed(1)}s
              </li>
              {activeAimBoost && <li className="text-emerald-300">Aim Boost Active</li>}
              {activeFreeze && <li className="text-cyan-300">Freeze Active</li>}
              {hud.level.timeLimitSeconds !== undefined && (
                <li className="text-amber-200">
                  Time Attack · Survive {hud.level.timeLimitSeconds}s
                </li>
              )}
              {hud.level.endless && (
                <li className="text-rose-300">Boss Descent: Unrelenting!</li>
              )}
            </ul>
          </div>
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-100">
            <div className="font-semibold text-emerald-300">How to Play</div>
            <ul className="mt-2 space-y-1">
              <li>Move the cursor to aim. Click or press Space to fire.</li>
              <li>Pop 3+ bubbles of the same color to clear them.</li>
              <li>Chain clears to boost your combo multiplier.</li>
              <li>Power-ups: Bomb (blast), Rainbow (wild), Freeze (slow), Aim (guide).</li>
              <li>Survive each pattern before the wall breaches the cannon.</li>
            </ul>
          </div>

          {statusMessage && (
            <div className="rounded-2xl border border-cyan-300/40 bg-cyan-300/10 px-4 py-3 text-sm text-cyan-100">
              {statusMessage}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BubbleShooter;
