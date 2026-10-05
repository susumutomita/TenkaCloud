/** Display themes without changing authored tags, problem IDs or course references. */
export function problemThemeTags(tags: readonly string[]): string[] {
  return [
    ...new Set(
      tags.map((tag) =>
        /^(?:advanced-cryptography(?:-\d{4})?|ac26)$/u.test(tag) ? "cryptography" : tag,
      ),
    ),
  ];
}

export function problemThemeLabel(tag: string, t: (key: string) => string): string {
  return tag === "cryptography" ? t("problems.theme_cryptography") : tag;
}
