import { CARD_GAP } from "./layout.js";

// New arrivals queue behind older cards without moving those cards.
// After a removal, ease toward the independent trajectory while respecting expiry.
function independentY(item, old, elapsed, fieldHeight) {
  const span = Math.max(1, item.deadline - item.born);
  const range = Math.max(0, fieldHeight - item.height);
  const desired = Math.max(8, Math.min(1, (elapsed - item.born) / span) * range);
  if (!old) return desired;
  const remaining = Math.max(1, item.deadline - old.elapsed);
  const speed = Math.max((range / span) * 3, (range - old.y) / remaining);
  return Math.min(desired, old.y + Math.max(0, elapsed - old.elapsed) * speed);
}
export function flowPositions(items, previous, elapsed, fieldHeight, columns, stationary = false) {
  const result = [];
  for (let lane = 0; lane < columns; lane++) {
    const ordered = items
      .filter((item) => item.slot % columns === lane)
      .sort((a, b) => a.born - b.born || a.uid - b.uid);
    let leader = null;
    for (const item of ordered) {
      let y = independentY(item, previous.get(String(item.uid)), elapsed, fieldHeight);
      if (stationary) y = leader ? leader.y + leader.height + CARD_GAP : 8;
      else if (leader) y = Math.min(y, leader.y - item.height - CARD_GAP);
      previous.set(String(item.uid), { y, elapsed });
      const entry = { ...item, y };
      result.push(entry);
      leader = entry;
    }
  }
  return result;
}
