/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Freelens serves its root frame from `https://renderer.freelens.app:<port>`
// and each cluster frame from `https://<clusterId>.renderer.freelens.app:<port>`,
// names that only its own Chromium resolves (to 127.0.0.1). The chat, the only
// caller of the bridge, runs in cluster frames, so they are the only origin
// the bridge serves. The root frame is left out on purpose.
const CLUSTER_FRAME_ORIGIN = /^https:\/\/[a-z0-9_-]+\.renderer\.freelens\.app(?::\d{1,5})?$/;

/** Whether `origin` is the origin of a Freelens cluster frame. */
export function isClusterFrameOrigin(origin: string | null | undefined): boolean {
  return typeof origin === "string" && CLUSTER_FRAME_ORIGIN.test(origin);
}
