/**
 * FNXC:PiAiTranscriptResolution 2026-11-04-09:44:
 * The pi extension loader (`@earendil-works/pi-coding-agent`'s jiti instance) resolves
 * bare-specifier imports through an alias table that maps the `@earendil-works/pi-ai`
 * PREFIX to the compat ENTRY FILE (`dist/compat.js`). A subpath import such as
 * `@earendil-works/pi-ai/utils/transcript` is not an alias key, so jiti appended the
 * subpath to that file and every agent session failed with
 * `Cannot find module '…/@earendil-works/pi-ai/dist/compat.js/utils/transcript'`
 * (production logs 2026-11-03/04); the whole extension was dropped at load.
 *
 * Resolution strategy: anchor on `@earendil-works/pi-ai/compat`, one of the loader's
 * exact alias keys, so it resolves identically under the jiti alias table (production
 * extension load) and under native exports-map resolution. pi-ai's own compat entry
 * imports `./utils/transcript.js`, so that sibling exists wherever compat.js exists.
 * The transcript module is ESM without top-level await and Node >= 22.12 loads it
 * synchronously via `require(esm)`, which keeps the provider's synchronous
 * `streamSimple` bridge intact.
 *
 * Vitest's module runner provides an `import.meta.resolve` that throws when called, so
 * `initPiAiTranscriptHelpers` falls back to the runner's own exports-map import there.
 * The extension factory awaits this init before registering the provider, so every
 * `streamSimple` call observes a settled cache in every loading environment.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  getCurrentSystemPrompt as GetCurrentSystemPromptFn,
  getCurrentTools as GetCurrentToolsFn,
} from "@earendil-works/pi-ai/utils/transcript";

type PiAiTranscriptModule = {
  getCurrentSystemPrompt: typeof GetCurrentSystemPromptFn;
  getCurrentTools: typeof GetCurrentToolsFn;
};

let cachedModule: PiAiTranscriptModule | undefined;
let pendingLoad: Promise<PiAiTranscriptModule> | undefined;

/**
 * jiti/native-ESM path: anchor the compat entry, then require(esm) the sibling transcript module.
 *
 * FNXC:PiAiTranscriptResolution 2026-11-04-10:55:
 * `import.meta.resolve` must stay a DIRECT call: jiti's transform only rewrites that exact
 * call syntax to its own resolver (which applies the extension-loader alias table, so the
 * alias-exact `./compat` key resolves to the compat entry file). An indirect
 * `import.meta.resolve.call(...)` escapes the rewrite and leaves the specifier unresolved
 * under the extension loader. Vitest's module runner instead throws on any
 * `import.meta.resolve` call, which routes to the async fallback in `loadTranscriptModule`.
 */
function loadTranscriptModuleSync(): PiAiTranscriptModule {
  const compatEntryUrl = import.meta.resolve("@earendil-works/pi-ai/compat");
  const transcriptModulePath = join(dirname(fileURLToPath(compatEntryUrl)), "utils", "transcript.js");
  return createRequire(import.meta.url)(transcriptModulePath) as PiAiTranscriptModule;
}

/** Load the module once; sync under jiti/native ESM, via the vitest module runner's exports-map import otherwise. */
async function loadTranscriptModule(): Promise<PiAiTranscriptModule> {
  try {
    return loadTranscriptModuleSync();
  } catch {
    return await import("@earendil-works/pi-ai/utils/transcript");
  }
}

/**
 * Load and cache the pi-ai transcript helpers. Idempotent; call from the extension
 * factory before registering the provider so every later synchronous helper call
 * observes a settled cache.
 */
export function initPiAiTranscriptHelpers(): Promise<PiAiTranscriptModule> {
  pendingLoad ??= loadTranscriptModule().then((module) => {
    cachedModule = module;
    return module;
  });
  return pendingLoad;
}

function requireLoadedModule(): PiAiTranscriptModule {
  if (!cachedModule) {
    throw new Error(
      "pi-ai transcript helpers are not initialized; await initPiAiTranscriptHelpers() in the extension factory before streaming",
    );
  }
  return cachedModule;
}

export function getCurrentSystemPrompt(...args: Parameters<typeof GetCurrentSystemPromptFn>): ReturnType<typeof GetCurrentSystemPromptFn> {
  return requireLoadedModule().getCurrentSystemPrompt(...args);
}

export function getCurrentTools(...args: Parameters<typeof GetCurrentToolsFn>): ReturnType<typeof GetCurrentToolsFn> {
  return requireLoadedModule().getCurrentTools(...args);
}
