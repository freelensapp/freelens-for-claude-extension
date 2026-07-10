/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";

const { Icon } = Renderer.Component;

// A twelve-spoke asterisk burst, echoing the Claude spark mark.
const rawSvg = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <g stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <line x1="12" y1="12" x2="12" y2="2"/>
    <line x1="12" y1="12" x2="17" y2="3.34"/>
    <line x1="12" y1="12" x2="20.66" y2="7"/>
    <line x1="12" y1="12" x2="22" y2="12"/>
    <line x1="12" y1="12" x2="20.66" y2="17"/>
    <line x1="12" y1="12" x2="17" y2="20.66"/>
    <line x1="12" y1="12" x2="12" y2="22"/>
    <line x1="12" y1="12" x2="7" y2="20.66"/>
    <line x1="12" y1="12" x2="3.34" y2="17"/>
    <line x1="12" y1="12" x2="2" y2="12"/>
    <line x1="12" y1="12" x2="3.34" y2="7"/>
    <line x1="12" y1="12" x2="7" y2="3.34"/>
  </g>
</svg>`;

export const ClaudeIcon = (props: React.ComponentProps<typeof Icon>) => <Icon {...props} svg={rawSvg} />;
