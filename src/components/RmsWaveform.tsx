import { useEffect, useRef } from "react";

const COLS = 46;
const ROWS = 8;
const CELL = 2;
const GAP = 1;
const PUSH_MS = 50;
const WIDTH = COLS * (CELL + GAP) - GAP;
const HEIGHT = ROWS * (CELL + GAP) - GAP;

// 三个预制色：底部青、中间黄、顶部红
function rowColor(row: number): string {
  const t = row / (ROWS - 1);
  if (t < 0.5) return "#26c6da";
  if (t < 0.8) return "#ffd54f";
  return "#ef5350";
}

interface RmsWaveformProps {
  // 主渲染循环每帧写入当前平滑后的 RMS，这里按固定节奏采样成历史
  levelRef: React.MutableRefObject<number>;
}

export function RmsWaveform({ levelRef }: RmsWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const historyRef = useRef<number[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    ctx.scale(dpr, dpr);

    let raf = 0;
    let lastPush = 0;

    const draw = (now: number) => {
      if (now - lastPush >= PUSH_MS) {
        lastPush = now;
        const history = historyRef.current;
        history.push(levelRef.current);
        if (history.length > COLS) history.shift();
      }

      ctx.fillStyle = "#0b0d12";
      ctx.fillRect(0, 0, WIDTH, HEIGHT);

      const history = historyRef.current;
      const offset = COLS - history.length;
      for (let col = 0; col < COLS; col++) {
        const value = col < offset ? 0 : history[col - offset];
        const filled = Math.round(Math.min(1, value) * ROWS);
        for (let row = 0; row < ROWS; row++) {
          const x = col * (CELL + GAP);
          const y = HEIGHT - (row + 1) * CELL - row * GAP;
          ctx.fillStyle = row < filled ? rowColor(row) : "rgba(255, 255, 255, 0.06)";
          ctx.fillRect(x, y, CELL, CELL);
        }
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => cancelAnimationFrame(raf);
  }, [levelRef]);

  return <canvas ref={canvasRef} className="rms-wave" style={{ width: WIDTH, height: HEIGHT }} />;
}
