/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The cluster session: a namespace with a Deployment and a Service
// (`integration/fixtures`). The chat page of the cluster opens with its
// composer, one prompt gets an answer of Claude, and the rows of the test
// objects carry the extension's menu item. The session disconnects the kind
// cluster, sets up the objects, connects the cluster again, and leaves it
// disconnected; it does not depend on another test file having run.
//
// The prompt starts a real Claude Code session, with the credentials Claude
// Code finds in the environment of Freelens dev, and costs one turn. With
// TEST_SKIP_CLAUDE_PROMPT set, as in a pull request in CI, which gets no
// credentials, it is skipped.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appReady,
  askClaude,
  clearConversation,
  connectApp,
  disconnectKindCluster,
  installExtension,
  listPages,
  openChat,
  openKindCluster,
  openListPage,
  openRowMenu,
  setUpCluster,
  tearDownCluster,
  waitForMenuItem,
} from "./extension-helpers";

import type { Frame } from "playwright";

import type { AppSession, ListPage } from "./extension-helpers";

const skipPrompt = Boolean(process.env.TEST_SKIP_CLAUDE_PROMPT);

describe.skipIf(!(await appReady({ cluster: true })))("chat and menu items", () => {
  let session: AppSession | undefined;
  let frame: Frame;

  beforeAll(
    async () => {
      session = await connectApp();
      await disconnectKindCluster(session);
      setUpCluster();
      await installExtension(session);
      frame = await openKindCluster(session);
    },
    10 * 60 * 1000,
  );

  afterAll(
    async () => {
      let errors: string[] = [];

      try {
        // The errors first: the app refreshes the cluster while it disconnects,
        // and logs errors of its own when the refresh loses the race.
        errors = (await session?.stopCollecting()) ?? [];

        // The cluster then: the list pages watch the test objects, which are
        // deleted next.
        if (session) {
          await disconnectKindCluster(session);
        }

        await session?.close();
      } finally {
        tearDownCluster();
      }

      expect(errors).toEqual([]);
    },
    10 * 60 * 1000,
  );

  // The first view of the cluster, so that the chat page loads its status,
  // events and models itself, under React.StrictMode in Freelens dev.
  it("opens the chat page with its composer", async () => {
    await openChat(frame);
  });

  it.skipIf(skipPrompt)("gets an answer of Claude", async () => {
    await openChat(frame);
    await clearConversation(frame);

    const answer = await askClaude(frame, "Reply with the single word PONG. Do not call any tools.", "PONG");

    expect(answer).toContain("PONG");
  });

  for (const [page, title] of Object.entries(listPages) as [ListPage, string][]) {
    it(`shows "Ask Claude" in the menu of a row of the ${title} page`, async () => {
      const row = await openListPage(frame, page);
      const menu = await openRowMenu(frame, row);

      await waitForMenuItem(frame, menu, "Ask Claude");
    });
  }
});
