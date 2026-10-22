/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { BridgeStore } from "../common/bridge-store";
import { PreferencesStore } from "../common/preferences-store";
import { BridgeIpc } from "./api/bridge-ipc";
import { ChatPage } from "./components/chat-page";
import { createAskClaudeMenuItem } from "./components/menu-entry";
import { PreferencesHint, PreferencesInput } from "./components/preferences";
import { ClaudeIcon } from "./icons/claude-icon";

const {
  K8sApi: { menuItemFor, DaemonSet, Deployment, KubeEvent, Node, Pod, Service, StatefulSet },
} = Renderer;

type KubeObject = Renderer.K8sApi.KubeObject;

const PAGE_ID = "chat";

/** Coordinates of the selected object, read via direct property access. */
function coordsOf(object: KubeObject): { kind: string; namespace?: string; name: string } {
  const meta = object.metadata ?? { name: "" };
  return { kind: object.kind, namespace: meta.namespace, name: meta.name };
}

/** Prompt for a workload/resource: let the model fetch live state through the freelens_ tools. */
function analyzePrompt(object: KubeObject): string {
  const { kind, namespace, name } = coordsOf(object);
  const ref = namespace ? `${kind} ${namespace}/${name}` : `${kind} ${name}`;
  return (
    `Analyze \`${ref}\` in this cluster: check its current state, recent warning events ` +
    "and (for workloads) pod logs, and summarize any problems."
  );
}

/** Prompt for an Event: parity with the original's "Explain", shown only when a message exists. */
function explainEventPrompt(object: Renderer.K8sApi.KubeEvent): string | undefined {
  const message = object.message;
  if (!message) return undefined;
  return `Could you explain this message?\n\n${message}`;
}

export default class ForClaudeRenderer extends Renderer.LensExtension {
  async onActivate(): Promise<void> {
    const store = BridgeStore.createInstance<BridgeStore>();
    store.loadExtension(this);
    BridgeIpc.createInstance(this);

    const preferences = PreferencesStore.createInstance<PreferencesStore>();
    preferences.loadExtension(this);
  }

  private readonly navigateToChat = () => void this.navigate(PAGE_ID);

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

  appPreferences = [
    {
      title: "Freelens for Claude",
      id: "freelens-for-claude-preferences",
      components: {
        Input: () => <PreferencesInput />,
        Hint: () => <PreferencesHint />,
      },
    },
  ];

  kubeObjectMenuItems = [
    menuItemFor(KubeEvent, { MenuItem: createAskClaudeMenuItem(explainEventPrompt, this.navigateToChat) }),
    menuItemFor(Pod, { MenuItem: createAskClaudeMenuItem(analyzePrompt, this.navigateToChat) }),
    menuItemFor(Deployment, { MenuItem: createAskClaudeMenuItem(analyzePrompt, this.navigateToChat) }),
    menuItemFor(DaemonSet, { MenuItem: createAskClaudeMenuItem(analyzePrompt, this.navigateToChat) }),
    menuItemFor(StatefulSet, { MenuItem: createAskClaudeMenuItem(analyzePrompt, this.navigateToChat) }),
    menuItemFor(Service, { MenuItem: createAskClaudeMenuItem(analyzePrompt, this.navigateToChat) }),
    menuItemFor(Node, { MenuItem: createAskClaudeMenuItem(analyzePrompt, this.navigateToChat) }),
  ];
}
