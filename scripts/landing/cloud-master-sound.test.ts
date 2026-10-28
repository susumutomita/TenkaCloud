import { expect, test } from "bun:test";
import { createPaperSound } from "../../landing/cloud-master/paper-sound.js";

function harness(state = "running") {
  let disconnects = 0;
  const sources = [],
    gains = [],
    buffers = [];
  const node = (extra = {}) => ({
    connect(target) {
      return target;
    },
    disconnect() {
      disconnects++;
    },
    ...extra,
  });
  const context = {
    state,
    currentTime: 0,
    sampleRate: 48000,
    destination: {},
    resume: async () => {
      context.state = "running";
    },
    createBuffer(_channels, length) {
      const data = new Float32Array(length);
      const buffer = { getChannelData: () => data };
      buffers.push(data);
      return buffer;
    },
    createBufferSource() {
      const source = node({
        playbackRate: { value: 1 },
        onended: null,
        started: false,
        start() {
          source.started = true;
        },
        stop() {
          source.onended?.();
        },
      });
      sources.push(source);
      return source;
    },
    createBiquadFilter: () => node({ frequency: { value: 0 }, Q: { value: 0 } }),
    createGain() {
      const gain = node({ gain: { value: 0 } });
      gains.push(gain);
      return gain;
    },
  };
  let created = 0;
  const sound = createPaperSound({
    createContext: () => {
      created++;
      return context;
    },
  });
  return {
    sound,
    context,
    sources,
    gains,
    buffers,
    created: () => created,
    disconnects: () => disconnects,
  };
}
test("page load is silent; audio requires gesture initialization and skips unavailable/suspended contexts", async () => {
  const h = harness("suspended");
  expect(h.created()).toBe(0);
  expect(h.sound.play()).toBe(false);
  h.sound.unlock();
  await Promise.resolve();
  expect(h.created()).toBe(1);
  expect(h.sound.play()).toBe(true);
  h.context.state = "suspended";
  expect(h.sound.play()).toBe(false);
  h.sound.stop();
  const missing = createPaperSound({ createContext: () => null });
  missing.unlock();
  expect(missing.play()).toBe(false);
  const blocked = createPaperSound({
    createContext: () => {
      throw Error("denied");
    },
  });
  expect(() => blocked.unlock()).not.toThrow();
  expect(blocked.play()).toBe(false);
});
test("rapid hits are quiet, limited to two voices, and can play again after cleanup without queued replay", () => {
  const h = harness();
  h.sound.unlock();
  expect(h.sound.play(0)).toBe(true);
  h.context.currentTime = 0.02;
  expect(h.sound.play(1)).toBe(false);
  h.context.currentTime = 0.05;
  expect(h.sound.play(1)).toBe(true);
  h.context.currentTime = 0.1;
  expect(h.sound.play(2)).toBe(false);
  expect(h.sources).toHaveLength(2);
  h.sources[0].onended();
  expect(h.sound.play(2)).toBe(true);
  expect(h.gains.every((x) => x.gain.value <= 0.04)).toBe(true);
  expect(h.buffers).toHaveLength(1);
  expect(h.buffers[0]).toHaveLength(4320);
  expect([...h.buffers[0]].every((x) => Number.isFinite(x) && Math.abs(x) <= 1)).toBe(true);
  h.sound.setEnabled(false);
  expect(h.disconnects()).toBe(9);
  expect(h.sound.enabled).toBe(false);
  h.context.currentTime = 10;
  expect(h.sound.play()).toBe(false);
  h.sound.setEnabled(true);
  expect(h.sound.play()).toBe(true);
  h.sound.stop();
  expect(h.sound.play()).toBe(true);
});
test("resume rejection and start failure cannot escape into game input", async () => {
  const h = harness("interrupted");
  h.context.resume = async () => {
    throw Error("blocked");
  };
  h.sound.unlock();
  await Promise.resolve();
  expect(h.sound.play()).toBe(false);
  h.context.state = "running";
  h.context.createBufferSource = () => {
    throw Error("unsupported");
  };
  expect(h.sound.play()).toBe(false);
  expect(() => h.sound.stop()).not.toThrow();
});
