import { describe, expect, it } from "vitest";
import { isProblemAuthors, projectProblemAuthors, safeAuthorProfileUrl } from "./problem-authors";

describe("explicit public author credits", () => {
  it("keeps absent and empty authors absent", () => {
    for (const value of [undefined, null, [], {}, "author"])
      expect(projectProblemAuthors(value)).toBeUndefined();
    expect(isProblemAuthors([])).toBe(true);
  });
  it("supports Japanese, long names, multiple authors and names without links", () => {
    const authors = [
      { name: "山田 太郎", profileUrl: "https://example.com/profile" },
      { name: "共同作者".repeat(100) },
    ];
    expect(isProblemAuthors(authors)).toBe(true);
    expect(projectProblemAuthors(authors)).toEqual(authors);
  });
  it("copies only public fields without interpreting markup or filling in identities", () => {
    expect(
      projectProblemAuthors([
        { name: "<script>alert(1)</script>", email: "hidden@example.com", secret: "ANSWER" },
      ]),
    ).toEqual([{ name: "<script>alert(1)</script>" }]);
    expect(isProblemAuthors([{ name: "author", email: "private" }])).toBe(false);
    expect(projectProblemAuthors([{ name: "  " }, null, { name: 4 }])).toBeUndefined();
  });
  it.each([
    ["javascript", "alert(1)"].join(":"),
    "data:text/html,evil",
    "file:///tmp/x",
    "//example.com",
    "/profile",
    "https://user:password@example.com",
    "https://example.com/ a",
    "https://example.com/\\evil",
    "https:///example.com",
    "https://",
    "https://example.com:99999",
    "https://example.com/\n",
  ])("rejects unsafe URL %s at authoring and renders the credit as text", (profileUrl) => {
    expect(safeAuthorProfileUrl(profileUrl)).toBeUndefined();
    expect(isProblemAuthors([{ name: "作者", profileUrl }])).toBe(false);
    expect(projectProblemAuthors([{ name: "作者", profileUrl }])).toEqual([{ name: "作者" }]);
  });
  it.each(["http://example.com", "https://example.com/profile?q=1#bio"])("accepts %s", (url) =>
    expect(safeAuthorProfileUrl(url)).toBe(url),
  );
});
