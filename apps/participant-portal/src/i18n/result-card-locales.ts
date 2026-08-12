/** Result Card の追加辞書。巨大な基礎 JSON を再生成せず、i18n composition root で合成する。 */
export const resultCardLocaleMessages = {
  ja: {
    title: "Result Card",
    description:
      "現在のスコアボードに表示されている公式値から、共有用画像をブラウザ内だけで生成します。チームIDや認証情報は含みません。",
    preview_alt:
      "{eventTitle} の結果カード。{teamName}、順位 {rank} 位、{score} 点、{completed}/{total} 問完了。",
    share_button: "画像を共有",
    download_button: "PNGを保存",
    share_success: "Result Cardを共有しました。",
    download_success: "Result CardをPNGで保存しました。",
    error_header: "Result Cardを生成できませんでした",
    error_body: "ブラウザの画像生成機能を利用できませんでした。画面を更新して、もう一度お試しください。",
    live_note: "LIVEは現在取得できているスコアのスナップショットです。最終順位ではありません。",
    final_note: "競技終了時刻を過ぎた公式スコアのスナップショットです。",
    share_unavailable: "このブラウザは画像ファイルの共有に対応していません。PNG保存は利用できます。",
  },
  en: {
    title: "Result Card",
    description:
      "Generate a shareable image in your browser from the official values currently shown on the scoreboard. Team IDs and credentials are never included.",
    preview_alt:
      "Result card for {eventTitle}. {teamName}, rank {rank}, {score} points, {completed} of {total} problems completed.",
    share_button: "Share image",
    download_button: "Download PNG",
    share_success: "The Result Card was shared.",
    download_success: "The Result Card was downloaded as a PNG.",
    error_header: "The Result Card could not be generated",
    error_body:
      "The browser image renderer was unavailable. Refresh the page and try again.",
    live_note: "LIVE is a snapshot of the score currently available. It is not a final result.",
    final_note: "This is an official score snapshot taken after the event end time.",
    share_unavailable:
      "This browser cannot share image files. PNG download remains available.",
  },
} as const;
