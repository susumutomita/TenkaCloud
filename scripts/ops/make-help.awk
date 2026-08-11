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
  print (lang == "ja" ? "言語: 日本語（英語: make help HELP_LANG=en）" : "Language: English (Japanese: make help HELP_LANG=ja)")
}

/^# =====/ {
  section = $0
  gsub(/^# ===== | =====$/, "", section)
  split(section, sections, " \\| ")
  printf "\n%s\n", (lang == "ja" ? sections[2] : sections[1])
}

/^[a-z][a-zA-Z0-9_-]*:.*## / {
  split($2, descriptions, " \\| ")
  printf "  %-30s %s\n", $1, (lang == "ja" ? descriptions[2] : descriptions[1])
}
