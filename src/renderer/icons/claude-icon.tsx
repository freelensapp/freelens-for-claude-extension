/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";

const { Icon } = Renderer.Component;

// A simple spark mark used for the cluster page menu entry.
const rawSvg = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path fill="currentColor" d="M12 2c.4 3.6 1.8 5 5.4 5.4C13.8 7.8 12.4 9.2 12 12.8 11.6 9.2 10.2 7.8 6.6 7.4 10.2 7 11.6 5.6 12 2Z"/>
  <path fill="currentColor" d="M18.5 12.5c.25 2.2 1.05 3 3.25 3.25-2.2.25-3 1.05-3.25 3.25-.25-2.2-1.05-3-3.25-3.25 2.2-.25 3-1.05 3.25-3.25Z"/>
  <path fill="currentColor" d="M6 13c.2 1.8.85 2.45 2.65 2.65C6.85 15.85 6.2 16.5 6 18.3c-.2-1.8-.85-2.45-2.65-2.65C5.15 15.45 5.8 14.8 6 13Z"/>
</svg>`;

export const ClaudeIcon = (props: React.ComponentProps<typeof Icon>) => <Icon {...props} svg={rawSvg} />;
