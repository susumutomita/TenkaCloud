export const hostContainerMessages = {
  en: {
    title: "Problem environment",
    status: {
      stopped: "Stopped",
      starting: "Starting…",
      running: "Running",
      stopping: "Stopping…",
      error: "Error",
    },
    start: "Start / resume",
    stop: "Stop (keep data)",
    retained: "Stopping preserves your work. Start again to resume it.",
    failed: "Environment operation failed",
    team_container_limit:
      "Your team has reached its active environment limit. Stop one of your running environments, then retry.",
    host_container_limit:
      "The host has reached its active environment limit. Stop an environment you no longer need, or ask the organizer to free capacity.",
    host_container_memory_limit:
      "The host's container memory budget is full. Stop an environment you no longer need, or ask the organizer to free capacity.",
    container_busy:
      "This environment is already changing. Wait for the current operation, then retry.",
  },
  ja: {
    title: "問題環境",
    status: {
      stopped: "停止中",
      starting: "起動中…",
      running: "実行中",
      stopping: "停止処理中…",
      error: "エラー",
    },
    start: "起動・再開",
    stop: "停止（データ保持）",
    retained: "停止しても作業データは保持されます。再開すると続きを実行できます。",
    failed: "問題環境の操作に失敗しました",
    team_container_limit:
      "チームの起動上限に達しています。実行中の環境を1つ停止してから、再度お試しください。",
    host_container_limit:
      "ホスト全体の起動上限に達しています。不要な環境を停止するか、主催者に空き容量の確保を相談してください。",
    host_container_memory_limit:
      "ホストのコンテナ用メモリ上限に達しています。不要な環境を停止するか、主催者に空き容量の確保を相談してください。",
    container_busy: "この環境は処理中です。現在の処理が終わってから、再度お試しください。",
  },
} as const;
