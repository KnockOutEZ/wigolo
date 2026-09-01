export {
  RESEARCHABLE_TYPES,
  STUDIO_EMBED_PREFIX,
  isResearchableArtifactType,
  isStudioEmbedKey,
  makeStudioEmbedKey,
  parseStudioEmbedKey,
} from './artifact-keys.js';
export type { StudioEmbedKeyParts } from './artifact-keys.js';
export { COMPANION_CONTRACT_VERSION, evaluateHandshake } from './handshake.js';
export type {
  CompanionHello,
  CompanionHelloApp,
  HandshakeRefusal,
  HandshakeResult,
} from './handshake.js';
