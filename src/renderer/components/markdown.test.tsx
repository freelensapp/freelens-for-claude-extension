// @vitest-environment jsdom
/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

// react-markdown 9 removed the `inline` prop that used to distinguish inline
// `` `code` `` from fenced code blocks. `markdown.tsx` splits the two cases
// across the `code` (inline) and `pre` (block) component overrides instead;
// these tests are the mechanical guard that the split keeps holding. The `pre`
// override renders `CodeViewer`, which the test host stub backs with a plain
// <textarea> (see `test/freelens-extensions.ts`).

describe("Markdown", () => {
  it("renders inline code as a plain <code>, not the code viewer", () => {
    const { container } = render(<Markdown>{"Restart the `nginx` pod now."}</Markdown>);

    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe("nginx");

    // The Monaco-backed viewer stub renders a <textarea>; inline code must not.
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("renders a fenced block in the code viewer, not as a bare <code>", () => {
    const markdown = ["```yaml", "kind: Pod", "```"].join("\n");
    const { container } = render(<Markdown>{markdown}</Markdown>);

    // The `pre` override does not render its <code> child, so no bare <code>
    // element survives for fenced blocks.
    expect(container.querySelector("code")).toBeNull();

    const viewer = container.querySelector("textarea");
    expect(viewer).not.toBeNull();
    expect((viewer as HTMLTextAreaElement).value).toContain("kind: Pod");
  });
});
