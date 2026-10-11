// Minimal stub of `@freelensapp/extensions` for unit tests.
//
// The published package is a shim that reads `Common`, `Main` and `Renderer`
// off `globalThis.FreelensExtensionApi`, which the Freelens host sets before it
// loads an extension. A Vitest process has no host, so importing the real
// package throws. `vitest.config.ts` aliases the import to this file instead.
// The package ships no mocks of its own to use in its place.
//
// Only the surface the tests exercise is stubbed here, and only at runtime: the
// tests are type-checked against the real declaration of the package. Extend it
// as your tests need more of the host API.
import React from "react";
import { vi } from "vitest";

// Minimal stand-in for the host Monaco editor. The real component pulls in the
// full Monaco runtime; the stub renders the value as a plain <textarea> so that
// components depending on it (e.g. `CodeViewer`) can be rendered in jsdom tests.
function MonacoEditor({ value }: { value?: string }) {
  return React.createElement("textarea", { readOnly: true, value: value ?? "" });
}

// Minimal stand-in for the host icon: the material name as text, or nothing
// for an SVG icon.
function Icon({ material }: { material?: string }) {
  return React.createElement("i", null, material);
}

export const Renderer = {
  Catalog: {
    getActiveCluster: vi.fn<() => { id: string } | undefined>(() => undefined),
  },
  Component: {
    Icon,
    MonacoEditor,
  },
};

// Minimal stand-in for the host `ExtensionStore` base class. The real one
// persists to disk: it loads the saved model with `fromStore()` and saves it
// whenever `toJSON()` changes. The stub keeps subclass state in memory so store
// logic (e.g. `ChatSessionStore`) can be unit-tested. As in the host, a store is
// a singleton per class; `resetInstance()` drops it between tests.
const instances = new Map<unknown, unknown>();

class ExtensionStore<_T> {
  constructor(_params: unknown) {}
  loadExtension(_extension: unknown): void {}
  static createInstance<T>(this: new () => T): T {
    const instance = new this();
    instances.set(this, instance);
    return instance;
  }
  static getInstance<T>(this: new () => T): T {
    return instances.get(this) as T;
  }
  static getInstanceOrCreate<T>(this: new () => T): T {
    return (
      (instances.get(this) as T | undefined) ?? (ExtensionStore.createInstance as (this: new () => T) => T).call(this)
    );
  }
  static resetInstance(this: unknown): void {
    instances.delete(this);
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
