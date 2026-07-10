/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Freelens host does not auto-load the extension's bundled stylesheet, so
// every SCSS module is pulled in here as raw compiled CSS (the `?inline` query)
// and injected through a single <style> element rendered at each page root.
// Class names stay scoped by the CSS-modules hash, so the rules never leak into
// the host. See the same pattern in freelens-ai-extension.
import chatPage from "./chat-page.module.scss?inline";
import chatView from "./chat-view.module.scss?inline";
import codeViewer from "./code-viewer.module.scss?inline";
import commandMenu from "./command-menu.module.scss?inline";
import markdown from "./markdown.module.scss?inline";
import onboarding from "./onboarding.module.scss?inline";
import permissionDialog from "./permission-dialog.module.scss?inline";
import preferences from "./preferences.module.scss?inline";
import slashMenu from "./slash-menu.module.scss?inline";
import toolCard from "./tool-card.module.scss?inline";
import usageDialog from "./usage-dialog.module.scss?inline";

const css = [
  chatPage,
  chatView,
  codeViewer,
  commandMenu,
  markdown,
  onboarding,
  permissionDialog,
  preferences,
  slashMenu,
  toolCard,
  usageDialog,
].join("\n");

/**
 * Injects the extension's scoped component styles. Rendered once at each
 * registered page root; duplicate identical rules across roots are harmless.
 */
export function Styles() {
  return <style>{css}</style>;
}
