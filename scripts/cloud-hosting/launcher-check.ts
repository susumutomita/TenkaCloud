import { assertCurrentLauncherConfiguration } from "./launcher-contract";

if (import.meta.main) {
  try {
    assertCurrentLauncherConfiguration(process.env);
    console.log(
      "Verified current-cloud-v1 source and launcher options. Only compatible reviewed catalog artifacts are executable.",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
