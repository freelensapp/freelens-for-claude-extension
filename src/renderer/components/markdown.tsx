/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeViewer } from "./code-viewer";
import styles from "./markdown.module.scss";

import type { ReactNode } from "react";

interface CodeBlockProps {
  inline?: boolean;
  className?: string;
  children?: ReactNode;
}

function CodeBlock({ inline, className, children }: CodeBlockProps) {
  if (inline) {
    return <code className={`${styles.inlineCode} ${className ?? ""}`.trim()}>{children}</code>;
  }

  // react-markdown tags fenced blocks with a `language-xxx` class; the file/code
  // body renders in the shared Monaco-backed viewer.
  const text = String(children ?? "").replace(/\n$/, "");
  const language = /language-(\w+)/.exec(className ?? "")?.[1];
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
          code: CodeBlock as never,
          a: ExternalLink as never,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
