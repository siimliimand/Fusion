/*
FNXC:RetryOutcomeClassification 2026-11-05-22:05 (KB-007, SUBC-008):
Thin entry for dashboard runtime-provider-probes vitest source aliases, mirroring the
Claude-runtime probes-entry pattern. Importing the full plugin index pulls the streaming
runtime-adapter (MCP transport, tool bridge) which binary probe / model discovery does not
need and which fails dashboard test resolution when dist/ is absent on a source checkout
(FN-9341 added the runtime-provider-probes import without the matching alias).
*/
export { probeAntigravityBinary, discoverAntigravityProviderModels } from "./probe.js";
export type { AntigravityBinaryStatus } from "./types.js";
