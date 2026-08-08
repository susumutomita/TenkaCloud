"use client";

import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import { MACHINE_API_SPEC } from "@/content/machine-api.generated";

/**
 * Issue #2950: machine API surface の Scalar レンダラ。
 *
 * spec は生成物を **inline で** 渡す。portal は static export なので、自分のリファレンスを
 * 描画するために GitHub その他へ runtime fetch しない (#2101 の禁止事項)。
 *
 * `hideTestRequestButton` は Phase 1 では外さない。この API は sandbox ではなく実データを
 * 操作するので ADR-0004 の sandbox 契約を満たさず、ブラウザから直接叩かせる Try-It を出す
 * わけにはいかない。判断そのものはページ本文にも明記してある。
 */
export function MachineApiReference() {
  return (
    <ApiReferenceReact
      configuration={{
        content: MACHINE_API_SPEC,
        hideTestRequestButton: true,
      }}
    />
  );
}
