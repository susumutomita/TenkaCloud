import { useEffect, useState } from "react";

/**
 * audit table #6 / 正解時の祝祭演出。 旧 UI は「提出済み」 という事務的 Alert を出すだけで、
 * 競技者が「やった！」 と感じる瞬間がなかった (= image #32 で 「正解時の喜びが無い」 指摘)。
 *
 * 本コンポーネントは画面全体に短時間 confetti animation を被せる:
 *   - ~3 秒で fade-out
 *   - pointer-events: none (= 操作の邪魔をしない)
 *   - 自前 CSS keyframes で実装 (= 外部 lib なし、 supply chain risk 増やさない)
 *
 * 重複起動防止: visible=true で render される度に key を変えて remount すれば毎回流れる。
 */

const COLORS = ["#fc4d75", "#ffb74d", "#4caf50", "#42a5f5", "#ab47bc", "#ffe082"];
const PARTICLE_COUNT = 60;
const DURATION_MS = 3000;

interface Particle {
  readonly id: number;
  readonly left: number; // 0-100 %
  readonly delay: number; // 0-500 ms
  readonly duration: number; // 1800-2800 ms
  readonly color: string;
  readonly rotate: number; // 0-360 deg
  readonly size: number; // 6-14 px
}

function buildParticles(seed: number): readonly Particle[] {
  // Deterministic pseudo-random so we don't rerun PRNG every render (= remount-cheap).
  const out: Particle[] = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const r = ((Math.sin(seed * 9301 + i * 49297) + 1) / 2 + 0.001) % 1;
    const r2 = ((Math.sin(seed * 233 + i * 7919) + 1) / 2 + 0.001) % 1;
    out.push({
      id: i,
      left: r * 100,
      delay: r2 * 500,
      duration: 1800 + r * 1000,
      color: COLORS[i % COLORS.length] ?? "#fc4d75",
      rotate: r * 360,
      size: 6 + r2 * 8,
    });
  }
  return out;
}

export function CelebrationOverlay({ visible }: { visible: boolean }) {
  const [active, setActive] = useState(false);
  const [mountKey, setMountKey] = useState(0);

  useEffect(() => {
    if (!visible) return;
    setMountKey((k) => k + 1);
    setActive(true);
    const t = setTimeout(() => setActive(false), DURATION_MS);
    return () => clearTimeout(t);
  }, [visible]);

  if (!active) return null;

  const particles = buildParticles(mountKey);
  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: 9999,
      }}
    >
      {particles.map((p) => (
        <span
          key={p.id}
          style={{
            position: "absolute",
            top: "-20px",
            left: `${p.left}%`,
            width: `${p.size}px`,
            height: `${p.size * 1.6}px`,
            backgroundColor: p.color,
            borderRadius: "2px",
            transform: `rotate(${p.rotate}deg)`,
            animation: `tc-celebrate-fall ${p.duration}ms cubic-bezier(0.3, 0.7, 0.4, 1) ${p.delay}ms forwards`,
          }}
        />
      ))}
      <style>{`
        @keyframes tc-celebrate-fall {
          0% {
            transform: translateY(0) rotate(0deg);
            opacity: 1;
          }
          100% {
            transform: translateY(110vh) rotate(720deg);
            opacity: 0.2;
          }
        }
      `}</style>
    </div>
  );
}
