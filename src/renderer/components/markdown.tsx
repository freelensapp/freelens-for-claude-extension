/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeViewer } from "./code-viewer";
import styles from "./markdown.module.scss";

import type { ReactNode } from "react";

/**
 * Inline `` `code` `` spans. Fenced blocks are handled by the `pre` override
 * below, which never renders its `<code>` child, so this only ever sees inline
 * code. react-markdown 9 removed the `inline` prop that used to distinguish the
 * two cases, so the split is now structural rather than prop-based.
 */
function InlineCode({ className, children }: { className?: string; children?: ReactNode }) {
  return <code className={`${styles.inlineCode} ${className ?? ""}`.trim()}>{children}</code>;
}

interface CodeElementProps {
  className?: string;
  children?: ReactNode;
}

/**
 * Fenced code blocks. react-markdown renders them as `<pre><code>...</code></pre>`
 * and tags the `<code>` with a `language-xxx` class; the file/code body renders
 * in the shared Monaco-backed viewer. Unwrapping the child here (rather than
 * rendering `children`) means the `code` override never fires for fenced blocks.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const code = isValidElement(children) ? (children.props as CodeElementProps) : undefined;
  const text = String(code?.children ?? "").replace(/\n$/, "");
  const language = /language-(\w+)/.exec(code?.className ?? "")?.[1];
  return <CodeViewer value={text} language={language} />;
}

/** Open links in the external browser rather than navigating the renderer. */
function ExternalLink({ href, children }: { href?: string; children?: ReactNode }) {
  const onClick = (event: React.MouseEvent) => {
    event.preventDefault();
    if (href) window.open(href, "_blank", "noopener,noreferrer");
  };
  return (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  );
}

/** Render assistant markdown with GFM, code copy buttons, and external links. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: InlineCode,
          pre: CodeBlock,
          a: ExternalLink,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
