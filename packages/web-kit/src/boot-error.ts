const MAX_BOOT_ERROR_DETAIL_LENGTH = 240;

function stringifyBootError(error: unknown): string {
  if (error instanceof Error) return error.message || "Unknown error";
  try {
    return String(error);
  } catch {
    return "Unknown error";
  }
}

function clampBootErrorDetail(detail: string): string {
  const trimmed = detail.trim();
  if (trimmed.length === 0) return "Unknown error";
  if (trimmed.length <= MAX_BOOT_ERROR_DETAIL_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_BOOT_ERROR_DETAIL_LENGTH - 3)}...`;
}

export function renderBootError(root: HTMLElement, error: unknown): void {
  const pre = root.ownerDocument.createElement("pre");
  pre.style.padding = "2rem";
  pre.style.color = "#a00";
  pre.style.fontFamily = "monospace";
  pre.style.whiteSpace = "pre-wrap";
  pre.textContent = `Config load failed: ${clampBootErrorDetail(stringifyBootError(error))}`;

  root.replaceChildren(pre);
}
