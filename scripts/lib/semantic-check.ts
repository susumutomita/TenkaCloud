/**
 * [Issue #1777] metadata.json の semantic validation rules。
 *
 * problems/SCHEMA.json (JSON Schema) は個々の field の構造までしか保証しないので、
 * field 間の整合性はここで enforce する (= 実 deploy / 採点 tick まで気付けない
 * 宣言ミスを出題時に止める)。
 *
 *   - uptime-multi: probedSlots[].slot の一意性、 slot 参照が endpoints[].slot に解決できる、
 *     weight (pointsAllOk / attackBlocked.pointsPerBlock / attackProbes[].penalty) の正値
 *   - phased-polling: phases[] が afterMinutes 厳密昇順 (= time-ordered, non-overlapping、
 *     SCHEMA description の「昇順で並べる規約」を機械化)、 name の一意性
 *   - disruptions: triggers[].kind=phase-entered の phaseName が phases[].name に実在
 *     (action.targetRef / functionRef の CFn Outputs 解決は disruption-action-check が担当)
 *   - flag: flagOutputKey 非空 (空文字は Outputs cross-ref の string-include を素通りする) /
 *     points 正値 / wrongAnswerPenalty は非負整数 (platform の parseFlag が silent drop する値を
 *     出題時に loud に reject) / hints penalty 合計 < points (全 hint 開示で報酬が消える宣言を禁止)
 *
 * validate-problems.ts から切り出した独立 module (= SRP / disruption-action-check.ts と同方針)。
 */

type Metadata = Record<string, unknown>;
type ValidationError = string;

function isPositiveNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function declaredEndpointSlots(meta: Metadata): Set<string> {
  const slots = new Set<string>();
  const endpoints = Array.isArray(meta.endpoints) ? meta.endpoints : [];
  for (const ep of endpoints as Array<Record<string, unknown>>) {
    if (ep && typeof ep.slot === "string") slots.add(ep.slot);
  }
  return slots;
}

function describeDeclaredSlots(slots: Set<string>): string {
  return slots.size > 0 ? [...slots].join(", ") : "(none)";
}

function checkSlotRef(field: string, slot: unknown, declared: Set<string>): ValidationError[] {
  if (typeof slot !== "string" || declared.has(slot)) return [];
  return [
    `${field}.slot="${slot}" not declared in endpoints[] (declared slots: ${describeDeclaredSlots(declared)})`,
  ];
}

function checkProbedSlots(
  probedSlots: readonly unknown[],
  declared: Set<string>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const seen = new Set<string>();
  probedSlots.forEach((raw, i) => {
    const slot = (raw as Record<string, unknown> | null)?.slot;
    if (typeof slot !== "string") return;
    if (seen.has(slot)) {
      errors.push(
        `scoring.probedSlots[${i}].slot="${slot}" is duplicated (uptime-multi probed slots must be unique)`,
      );
    }
    seen.add(slot);
    errors.push(...checkSlotRef(`scoring.probedSlots[${i}]`, slot, declared));
  });
  return errors;
}

function checkAttackBlocked(attackBlocked: unknown, declared: Set<string>): ValidationError[] {
  if (!attackBlocked || typeof attackBlocked !== "object" || Array.isArray(attackBlocked)) {
    return [];
  }
  const b = attackBlocked as Record<string, unknown>;
  const errors = checkSlotRef("scoring.attackBlocked", b.slot, declared);
  if (b.pointsPerBlock !== undefined && !isPositiveNumber(b.pointsPerBlock)) {
    errors.push("scoring.attackBlocked.pointsPerBlock must be a positive number");
  }
  return errors;
}

function checkAttackProbes(attackProbes: unknown, declared: Set<string>): ValidationError[] {
  if (!Array.isArray(attackProbes)) return [];
  const errors: ValidationError[] = [];
  attackProbes.forEach((raw, i) => {
    const p = raw as Record<string, unknown> | null;
    if (!p || typeof p !== "object") return;
    errors.push(...checkSlotRef(`scoring.attackProbes[${i}]`, p.slot, declared));
    if (p.penalty !== undefined && !isPositiveNumber(p.penalty)) {
      errors.push(`scoring.attackProbes[${i}].penalty must be a positive number`);
    }
  });
  return errors;
}

/**
 * kind=uptime-multi の semantic check。 probedSlots[].slot は一意 (= 同一 endpoint の二重 probe
 * は AND 条件の宣言ミス) かつ endpoints[].slot に解決できること。 weight 系 field は正値。
 */
export function checkUptimeMultiSemantics(meta: Metadata): ValidationError[] {
  const scoring = meta.scoring as Record<string, unknown> | undefined;
  if (scoring?.kind !== "uptime-multi") return [];

  const declared = declaredEndpointSlots(meta);
  const errors: ValidationError[] = [];
  if (Array.isArray(scoring.probedSlots)) {
    errors.push(...checkProbedSlots(scoring.probedSlots, declared));
  }
  if (scoring.pointsAllOk !== undefined && !isPositiveNumber(scoring.pointsAllOk)) {
    errors.push("scoring.pointsAllOk must be a positive number");
  }
  errors.push(...checkAttackBlocked(scoring.attackBlocked, declared));
  errors.push(...checkAttackProbes(scoring.attackProbes, declared));
  return errors;
}

/**
 * phases[] の timeline check。 SCHEMA description の「phases[] は afterMinutes 昇順で並べる規約」
 * を機械化する: 厳密昇順 (= time-ordered かつ同時刻の重複なし)、 name は一意。
 * 主に kind=phased-polling が使うが、 phases[] を宣言したどの問題にも適用する。
 */
export function checkPhaseTimeline(meta: Metadata): ValidationError[] {
  const phases = Array.isArray(meta.phases) ? meta.phases : [];
  const errors: ValidationError[] = [];
  const seenNames = new Set<string>();
  let prev: { afterMinutes: number; name: string } | undefined;
  phases.forEach((raw, i) => {
    const p = raw as Record<string, unknown> | null;
    if (!p || typeof p !== "object") return;
    const name = typeof p.name === "string" ? p.name : `#${i}`;
    if (seenNames.has(name)) {
      errors.push(`phases[${i}].name="${name}" is duplicated (phase names must be unique)`);
    }
    seenNames.add(name);
    const afterMinutes = p.afterMinutes;
    if (typeof afterMinutes !== "number" || !Number.isFinite(afterMinutes)) return;
    if (prev && afterMinutes <= prev.afterMinutes) {
      errors.push(
        `phases[${i}] (name="${name}", afterMinutes=${afterMinutes}) must come strictly after ` +
          `phases preceding it (name="${prev.name}", afterMinutes=${prev.afterMinutes}) — ` +
          "declare phases in strictly ascending afterMinutes order (time-ordered, non-overlapping)",
      );
    }
    prev = { afterMinutes, name };
  });
  return errors;
}

/**
 * disruptions[].triggers[] の参照整合性。 kind=phase-entered の phaseName は phases[].name に
 * 実在しなければならない (= 存在しない phase を待ち続けて永遠に発火しない宣言を出題時に止める)。
 * CFn Outputs への参照 (action.targetRef / functionRef) は disruption-action-check.ts が担当。
 */
export function checkDisruptionTriggerRefs(meta: Metadata): ValidationError[] {
  const disruptions = Array.isArray(meta.disruptions) ? meta.disruptions : [];
  const phases = Array.isArray(meta.phases) ? meta.phases : [];
  const phaseNames = new Set<string>();
  for (const p of phases as Array<Record<string, unknown>>) {
    if (p && typeof p.name === "string") phaseNames.add(p.name);
  }

  const errors: ValidationError[] = [];
  for (const raw of disruptions as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.triggers)) continue;
    const id = typeof raw.id === "string" ? raw.id : "?";
    raw.triggers.forEach((trigger, i) => {
      const t = trigger as Record<string, unknown> | null;
      if (!t || t.kind !== "phase-entered" || typeof t.phaseName !== "string") return;
      if (!phaseNames.has(t.phaseName)) {
        errors.push(
          `disruptions[id=${id}].triggers[${i}] phase-entered references unknown phaseName="${t.phaseName}" ` +
            `(declared phases: ${describeDeclaredSlots(phaseNames)})`,
        );
      }
    });
  }
  return errors;
}

function totalHintPenalty(hints: unknown): number {
  if (!Array.isArray(hints)) return 0;
  let total = 0;
  for (const hint of hints) {
    const penalty = (hint as Record<string, unknown> | null)?.penalty;
    if (typeof penalty === "number" && Number.isFinite(penalty) && penalty > 0) total += penalty;
  }
  return total;
}

function checkWrongAnswerPenalty(penalty: unknown): ValidationError[] {
  if (penalty === undefined) return [];
  if (
    typeof penalty === "number" &&
    Number.isFinite(penalty) &&
    Number.isInteger(penalty) &&
    penalty >= 0
  ) {
    return [];
  }
  return [
    `scoring.wrongAnswerPenalty=${String(penalty)} must be a non-negative integer ` +
      "(the platform parseFlag silently drops invalid values — fail loudly at authoring time instead)",
  ];
}

/**
 * kind=flag の semantic check。 flagOutputKey は非空 (空文字は `yaml.includes(":")` の
 * Outputs cross-ref を素通りして採点が壊れる)、 points は正値、 wrongAnswerPenalty は
 * platform parser (scoring-metadata.ts parseFlag) が受理する非負整数、 hints の penalty 合計は
 * points 未満 (= 全 hint を開示しても報酬が残る宣言だけを許す)。
 */
export function checkFlagSemantics(meta: Metadata): ValidationError[] {
  const scoring = meta.scoring as Record<string, unknown> | undefined;
  if (scoring?.kind !== "flag") return [];

  const errors: ValidationError[] = [];
  if (typeof scoring.flagOutputKey !== "string" || scoring.flagOutputKey.trim() === "") {
    errors.push(
      "scoring.flagOutputKey must be a non-empty string (an empty key degenerately passes the template Outputs cross-ref)",
    );
  }
  if (!isPositiveNumber(scoring.points)) {
    errors.push("scoring.points must be a positive number");
  }
  errors.push(...checkWrongAnswerPenalty(scoring.wrongAnswerPenalty));

  const penaltyTotal = totalHintPenalty(scoring.hints);
  if (isPositiveNumber(scoring.points) && penaltyTotal >= (scoring.points as number)) {
    errors.push(
      `scoring.hints total penalty (${penaltyTotal}) must be less than scoring.points (${String(scoring.points)}) ` +
        "— revealing every hint must not zero out the flag reward",
    );
  }
  return errors;
}
