import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CodeTextarea } from "./CodeTextarea";

function Harness({ initial }: { readonly initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <CodeTextarea value={value} onChange={setValue} rows={8} />
      <button type="button">after</button>
    </>
  );
}

async function setup(initial: string) {
  const user = userEvent.setup();
  render(<Harness initial={initial} />);
  const field = screen.getByRole("textbox") as HTMLTextAreaElement;
  await user.click(field);
  return { user, field };
}

function place(field: HTMLTextAreaElement, start: number, end = start) {
  field.setSelectionRange(start, end);
}

describe("CodeTextarea", () => {
  it("indents at the caret instead of moving focus", async () => {
    const { user, field } = await setup("def f():\npass");
    place(field, field.value.indexOf("pass"));
    await user.keyboard("{Tab}");
    expect(field.value).toBe("def f():\n    pass");
    expect(field).toHaveFocus();
  });

  it("indents every line the selection touches", async () => {
    const { user, field } = await setup("a = 1\nb = 2");
    place(field, 0, field.value.length);
    await user.keyboard("{Tab}");
    expect(field.value).toBe("    a = 1\n    b = 2");
  });

  it("outdents with Shift+Tab and stops at the margin", async () => {
    const { user, field } = await setup("    a = 1\n  b = 2");
    place(field, 0, field.value.length);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(field.value).toBe("a = 1\nb = 2");
  });

  it("releases focus when Escape arms the next Tab", async () => {
    const { user, field } = await setup("a = 1");
    place(field, 5);
    await user.keyboard("{Escape}{Tab}");
    expect(field.value).toBe("a = 1");
    expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
  });

  it("comments and uncomments the touched lines", async () => {
    const { user, field } = await setup("    a = 1\n    b = 2");
    place(field, 0, field.value.length);
    await user.keyboard("{Control>}/{/Control}");
    expect(field.value).toBe("    # a = 1\n    # b = 2");
    place(field, 0, field.value.length);
    await user.keyboard("{Control>}/{/Control}");
    expect(field.value).toBe("    a = 1\n    b = 2");
  });

  it("keeps blank lines out of the comment toggle", async () => {
    const { user, field } = await setup("a = 1\n\nb = 2");
    place(field, 0, field.value.length);
    await user.keyboard("{Control>}/{/Control}");
    expect(field.value).toBe("# a = 1\n\n# b = 2");
  });

  it("carries the indentation to the next line", async () => {
    const { user, field } = await setup("    a = 1");
    place(field, field.value.length);
    await user.keyboard("{Enter}");
    expect(field.value).toBe("    a = 1\n    ");
  });

  it("deepens the indentation after a colon", async () => {
    const { user, field } = await setup("def f():");
    place(field, field.value.length);
    await user.keyboard("{Enter}");
    expect(field.value).toBe("def f():\n    ");
  });

  it("still types normal characters", async () => {
    const { user, field } = await setup("");
    await user.keyboard("x = 1");
    expect(field.value).toBe("x = 1");
  });

  it("leaves an all-blank selection alone", async () => {
    const { user, field } = await setup("\n\n");
    place(field, 0, field.value.length);
    await user.keyboard("{Control>}/{/Control}");
    expect(field.value).toBe("\n\n");
  });

  it("uncomments a bare # with no following space", async () => {
    const { user, field } = await setup("#a = 1");
    place(field, 0, field.value.length);
    await user.keyboard("{Control>}/{/Control}");
    expect(field.value).toBe("a = 1");
  });

  it("comments the last line when the file has no trailing newline", async () => {
    const { user, field } = await setup("a = 1");
    place(field, field.value.length);
    await user.keyboard("{Control>}/{/Control}");
    expect(field.value).toBe("# a = 1");
  });

  it("leaves Shift+Enter to the browser, so the new line is not indented", async () => {
    const { user, field } = await setup("    a = 1");
    place(field, field.value.length);
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(field.value).toBe("    a = 1\n");
  });

  it("comments only the lines the selection reaches", async () => {
    const { user, field } = await setup("a = 1\nb = 2");
    place(field, 0, 3);
    await user.keyboard("{Control>}/{/Control}");
    expect(field.value).toBe("# a = 1\nb = 2");
  });

  it("toggles comments with Meta as well as Control", async () => {
    const { user, field } = await setup("a = 1");
    place(field, 0, field.value.length);
    await user.keyboard("{Meta>}/{/Meta}");
    expect(field.value).toBe("# a = 1");
  });

  it("does nothing while disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CodeTextarea value="a = 1" onChange={onChange} rows={4} disabled />);
    const field = screen.getByRole("textbox") as HTMLTextAreaElement;
    field.focus();
    await user.keyboard("{Tab}");
    expect(field.value).toBe("a = 1");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disarms Escape when the next key is not Tab", async () => {
    const { user, field } = await setup("a = 1");
    place(field, field.value.length);
    await user.keyboard("{Escape}b");
    place(field, field.value.length);
    await user.keyboard("{Tab}");
    expect(field.value).toBe("a = 1b    ");
  });
});
