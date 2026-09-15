/** Named optional environment inputs used by the shared hosting runtime. */
declare namespace NodeJS {
  interface ProcessEnv {
    CONTROL_DATA_BACKEND?: string;
    CONTROL_DATA_TURSO_URL?: string;
    CONTROL_DATA_TURSO_AUTH_TOKEN?: string;
    CONTROL_DATA_ENV?: string;
    TENKACLOUD_COMPOSE_CLI?: string;
    CODESPACE_NAME?: string;
    GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?: string;
  }
}
