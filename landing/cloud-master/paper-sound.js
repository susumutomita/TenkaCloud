const DURATION = 0.09;
const VOLUME = 0.04;
const MIN_INTERVAL = 0.045;
const MAX_VOICES = 2;
function audioContext() {
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return Context ? new Context({ latencyHint: "interactive" }) : null;
}
function paperBuffer(context) {
  const buffer = context.createBuffer(
    1,
    Math.ceil(context.sampleRate * DURATION),
    context.sampleRate,
  );
  const data = buffer.getChannelData(0);
  let seed = 0x70617065;
  for (let i = 0; i < data.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const t = i / context.sampleRate;
    const edge = Math.min(1, t / 0.003, (DURATION - t) / 0.008);
    const rustle = Math.exp(-t * 65) + 0.45 * Math.exp(-(((t - 0.034) / 0.015) ** 2));
    data[i] = ((seed >>> 0) / 0x80000000 - 1) * edge * Math.min(1, rustle);
  }
  return buffer;
}
// This controller never queues a sound: unavailable or suspended audio simply skips a hit.
export function createPaperSound({ createContext = audioContext } = {}) {
  let context = null,
    buffer = null,
    enabled = true,
    lastAt = -Infinity;
  const voices = new Set();
  function stop() {
    for (const voice of [...voices]) voice.stop();
    lastAt = -Infinity;
  }
  return {
    get enabled() {
      return enabled;
    },
    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) stop();
    },
    // Call only from a trusted user gesture; initial page load never creates a context.
    unlock() {
      if (!enabled) return;
      try {
        context ??= createContext();
        if (["suspended", "interrupted"].includes(context?.state))
          void context.resume().catch(() => {});
      } catch {}
    },
    play(variant = 0) {
      if (!enabled || context?.state !== "running") return false;
      const now = context.currentTime;
      if (now - lastAt < MIN_INTERVAL || voices.size >= MAX_VOICES) return false;
      const nodes = [];
      let voice;
      const cleanup = () => {
        if (voice) voices.delete(voice);
        for (const node of nodes.splice(0)) node.disconnect();
      };
      try {
        buffer ??= paperBuffer(context);
        const source = context.createBufferSource(),
          filter = context.createBiquadFilter(),
          gain = context.createGain();
        nodes.push(source, filter, gain);
        source.buffer = buffer;
        source.playbackRate.value = 1 + ((Math.abs(variant) % 3) - 1) * 0.06;
        filter.type = "bandpass";
        filter.frequency.value = 2600;
        filter.Q.value = 0.65;
        gain.gain.value = VOLUME;
        source.connect(filter).connect(gain).connect(context.destination);
        voice = {
          stop() {
            try {
              source.stop();
            } catch {}
            cleanup();
          },
        };
        source.onended = cleanup;
        voices.add(voice);
        source.start(now);
        lastAt = now;
        return true;
      } catch {
        cleanup();
        return false;
      }
    },
    stop,
  };
}
