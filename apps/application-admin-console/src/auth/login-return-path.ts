const LOGIN_RETURN_PATH_KEY = "TenkaCloud.application_admin.login_return_path";
const APP_ORIGIN = "https://application-admin.invalid";
const DEFAULT_RETURN_PATH = "/";

interface LocationParts {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

export function buildLoginReturnPath(location: LocationParts): string {
  return (
    sanitizeLoginReturnPath(`${location.pathname}${location.search}${location.hash}`) ??
    DEFAULT_RETURN_PATH
  );
}

export function readLoginReturnPathState(state: unknown): string | undefined {
  if (!state || typeof state !== "object" || !("returnPath" in state)) return undefined;
  return sanitizeLoginReturnPath((state as { readonly returnPath?: unknown }).returnPath);
}

export function rememberLoginReturnPath(returnPath: unknown): void {
  const safePath = sanitizeLoginReturnPath(returnPath);
  try {
    if (safePath) {
      sessionStorage.setItem(LOGIN_RETURN_PATH_KEY, safePath);
    } else {
      sessionStorage.removeItem(LOGIN_RETURN_PATH_KEY);
    }
  } catch {
    // Storage may be unavailable in privacy-restricted browsers. Fall back to home after login.
  }
}

export function consumeLoginReturnPath(): string {
  try {
    const returnPath = sessionStorage.getItem(LOGIN_RETURN_PATH_KEY);
    sessionStorage.removeItem(LOGIN_RETURN_PATH_KEY);
    return sanitizeLoginReturnPath(returnPath) ?? DEFAULT_RETURN_PATH;
  } catch {
    return DEFAULT_RETURN_PATH;
  }
}

function sanitizeLoginReturnPath(returnPath: unknown): string | undefined {
  if (
    typeof returnPath !== "string" ||
    !returnPath.startsWith("/") ||
    returnPath.startsWith("//")
  ) {
    return undefined;
  }
  const url = new URL(returnPath, APP_ORIGIN);
  if (url.origin !== APP_ORIGIN || url.pathname === "/login" || url.pathname === "/callback") {
    return undefined;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
