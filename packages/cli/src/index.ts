// @fluxstack/live-cli — Public API
// Re-exports utilities that can be used programmatically

export { C, color, colorForType } from './colors.js'
export { formatMessage, formatBinaryFrame, collectLeafPaths, summarize, type FormatOptions } from './format.js'
export { decodeMsgpack, decodeBinaryFrame, BINARY_STATE_DELTA } from './msgpack.js'
export {
  InspectorSession,
  parseArgs,
  resolveConfig,
  applyStateDelta,
  helpText,
  type InspectorConfig,
  type InspectorIO,
  type CommandResult,
  type ComponentState,
} from './session.js'
