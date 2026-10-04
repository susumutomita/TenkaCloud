import { expect, test } from "bun:test";
import { gatewayText } from "../gateway-text";

test("challenge text follows only the authenticated job's public gateway origins", () => {
  const original = {
    instructions:
      "Open http://127.0.0.1:19080/app?step=2 and http://localhost:19080/help. Keep http://127.0.0.1:19081/verify internal.",
    i18n: { en: { instructions: "`http://127.0.0.1:19080`" } },
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- Non-network malformed-port fixture.
    hints: [{ content: "http://127.0.0.1:190800 is a different port" }],
  };
  const result = gatewayText(
    original,
    new Map([
      ["http://127.0.0.1:19080", "https://exercise.example.test"],
      ["http://localhost:19080", "https://exercise.example.test"],
    ]),
  );
  expect(result.instructions).toBe(
    "Open https://exercise.example.test/app?step=2 and https://exercise.example.test/help. Keep http://127.0.0.1:19081/verify internal.",
  );
  expect(result.i18n.en.instructions).toBe("`https://exercise.example.test`");
  expect(result.hints).toEqual(original.hints);
  expect(original.instructions).toContain("http://127.0.0.1:19080/app");
});
