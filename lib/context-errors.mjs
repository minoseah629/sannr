import { CLI_NAME } from './brand.mjs';
// Public context diagnostics are selected, never copied from an arbitrary
// error. Filesystem and parser messages can carry input values or local paths.
const MESSAGES = Object.freeze({
  CONTEXT_INPUT_INVALID: 'The context input must use the supported bounded JSON shape.',
  CONTEXT_IDENTITY_INVALID: 'The operation identity is invalid; use bounded identifiers without query arguments or credentials.',
  CONTEXT_VERSION_UNSUPPORTED: 'The saved context or operation identity version is unsupported; the existing file was preserved.',
  CONTEXT_INVALID: 'The saved context is damaged or unsafe; the existing file was preserved.',
  CONTEXT_EVIDENCE_INVALID: 'Evidence must be an unlinked project-local file; locators must be JSON pointers that omit absolute workstation paths.',
  CONTEXT_EVIDENCE_MISSING: 'The selected project-local evidence file is missing.',
  CONTEXT_EVIDENCE_CHANGED: 'The evidence no longer matches its retained identity.',
  CONTEXT_SECRET_REFUSED: 'The context metadata appears to contain credentials; use environment-variable references only.',
  CONTEXT_CAPACITY_REACHED: 'The context exceeds its storage or operation bound; the existing file was preserved.',
  CONTEXT_WRITE_LOCKED: 'The context write lock is held by another writer; allow it to finish before retrying.',
  CONTEXT_TOO_LARGE: 'The selected context exceeds its supported read limit.',
  CONTEXT_LEGACY_MISSING: 'The selected legacy operation or inspection is absent or ambiguous.',
  CONTEXT_READ_FAILED: 'The context could not be read safely.',
  CONTEXT_DISABLED: 'Shared context is disabled by API_CONTEXT_OFF=1; no evidence was read and nothing was written.',
  CONTEXT_EVIDENCE_ROOT_UNSAFE: 'The local evidence directory must be an unlinked directory with unlinked ancestors; nothing was written.',
  KEY_SOURCES_INVALID: 'A stored key_sources list failed validation; its links are treated as absent and the record keeps its observations. context keys replaces it.',
  CONTEXT_COMMAND_FAILED: 'The context command could not be completed.',
});

export function contextCommandError(error) {
  if (error?.code === 'STACKS_MIGRATION_REQUIRED') return { code: error.code,
    message: 'Shared knowledge requires migration into named API stacks.', next: `${CLI_NAME} migrate --dry-run` };

  const code = typeof error?.code === 'string' && Object.hasOwn(MESSAGES, error.code)
    ? error.code : 'CONTEXT_COMMAND_FAILED';
  return { code, message: MESSAGES[code],
    next: 'Review the input and project-local evidence references; see docs/protocols.md.' };
}
