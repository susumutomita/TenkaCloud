# Render bilingual Makefile metadata without requiring Bun dependencies.
#
# Sections use: # ===== English | Japanese =====
# Targets use:  target: prerequisites ## English | Japanese

BEGIN {
  FS = ":.*## "
  if (lang != "en" && lang != "ja") {
    print "HELP_LANG must be en or ja" > "/dev/stderr"
    exit 2
  }
  if (scope == "") scope = "user"
  if (scope != "user" && scope != "developer") {
    print "HELP_SCOPE must be user or developer" > "/dev/stderr"
    exit 2
  }
  print (lang == "ja" ? "言語: 日本語（英語: make help HELP_LANG=en）" : "Language: English (Japanese: make help HELP_LANG=ja)")
}

/^# =====/ {
  if (scope != "developer") next
  section = $0
  gsub(/^# ===== | =====$/, "", section)
  split(section, sections, " \\| ")
  printf "\n%s\n", (lang == "ja" ? sections[2] : sections[1])
}

/^[a-z][a-zA-Z0-9_-]*:.*## / {
  split($2, descriptions, " \\| ")
  description = (lang == "ja" ? descriptions[2] : descriptions[1])
  if (scope == "user") {
    summaries[$1] = description
    next
  }
  printf "  %-30s %s\n", $1, description
}

function show_commands(names, title, targets, count, i) {
  printf "\n%s\n", title
  count = split(names, targets, " ")
  for (i = 1; i <= count; i++) {
    if (!(targets[i] in summaries)) {
      print "Missing documented Make target: " targets[i] > "/dev/stderr"
      exit 2
    }
    printf "  %-30s %s\n", targets[i], summaries[targets[i]]
  }
}

END {
  if (scope == "user" && (lang == "en" || lang == "ja")) {
    show_commands("local down local-reset local-clear deploy destroy turso-reset", lang == "ja" ? "開催・停止" : "Hosting")
    show_commands("env-init turso-live turso-live-guide turso-live-preflight turso-deploy-preflight turso-live-verify-cfn turso-token-rotate", lang == "ja" ? "クラウド設定・認証更新" : "Cloud setup and credentials")
    show_commands("submodule-latest validate-problems build", lang == "ja" ? "問題ソース・カタログ更新" : "Problem sources and catalog updates")
    show_commands("install test lint before-commit", lang == "ja" ? "開発用" : "Development")
    print (lang == "ja" ? "\n開発用の全コマンド: make help HELP_SCOPE=developer" : "\nAll development commands: make help HELP_SCOPE=developer")
  }
}
