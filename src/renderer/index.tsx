/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { BridgeStore } from "../common/bridge-store";
import { ChatPage } from "./components/chat-page";
import { ClaudeIcon } from "./icons/claude-icon";

const PAGE_ID = "chat";

export default class ForClaudeRenderer extends Renderer.LensExtension {
  async onActivate(): Promise<void> {
    const store = BridgeStore.createInstance<BridgeStore>();
    store.loadExtension(this);
  }

  clusterPages = [
    {
      id: PAGE_ID,
      components: {
        Page: () => <ChatPage />,
      },
    },
  ];

  clusterPageMenus = [
    {
      target: { pageId: PAGE_ID },
      title: "Freelens for Claude",
      components: {
        Icon: ClaudeIcon,
      },
    },
  ];
}
