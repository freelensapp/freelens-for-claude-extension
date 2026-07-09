// Minimal stub of the host-provided `@freelensapp/extensions` module.
//
// At runtime Freelens injects this module as the `global.LensExtensions`
// global, so it is never bundled (see `globalExternals` in
// `electron.vite.config.js`) and cannot be imported in a plain Node/vitest
// process - the real package pulls in Electron. Unit tests alias the import to
// this file instead (see the `alias` option in `vitest.config.ts`).
//
// Only the surface actually exercised by the tests is stubbed here. Extend it
// as your tests need more of the host API.
import { vi } from "vitest";

class LensExtensionKubeObject {
  apiVersion?: string;
  kind?: string;
  metadata?: unknown;
  spec?: unknown;
  status?: unknown;

  constructor(data: Record<string, unknown> = {}) {
    Object.assign(this, data);
  }
}

export const Renderer = {
  K8sApi: {
    LensExtensionKubeObject,
    KubeApi: class KubeApi {},
    KubeObjectStore: class KubeObjectStore {},
  },
};

// Minimal stand-in for the host `ExtensionStore` base class. The real one
// persists to disk and is a host singleton; the stub keeps subclass state in
// memory so store logic (e.g. `ChatSessionStore`) can be unit-tested.
class ExtensionStore<_T> {
  constructor(_params: unknown) {}
  loadExtension(_extension: unknown): void {}
  static createInstance<T>(this: new () => T): T {
    return new this();
  }
  static getInstance<T>(this: new () => T): T {
    return new this();
  }
  static getInstanceOrCreate<T>(this: new () => T): T {
    return new this();
  }
}

export const Common = {
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  App: {
    Preferences: {
      getKubectlPath: vi.fn<() => string | undefined>(() => undefined),
    },
  },
  Store: {
    ExtensionStore,
  },
};
