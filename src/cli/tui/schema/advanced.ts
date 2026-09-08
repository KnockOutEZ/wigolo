import type { CategoryDef } from './types.js';
import { field } from './from-registry.js';

export const advancedCategory: CategoryDef = {
  id: 'advanced',
  label: 'Advanced',
  description: 'Logging, proxy, daemon host/port',
  fields: [
    field('logLevel', {
      label: 'Log level',
      kind: 'select',
      options: [
        { value: 'debug', label: 'debug' },
        { value: 'info', label: 'info' },
        { value: 'warn', label: 'warn' },
        { value: 'error', label: 'error' },
      ],
    }),
    field('proxyUrl', {
      label: 'Proxy URL',
      kind: 'text',
      help: 'HTTP proxy URL. Bring your own proxy — wigolo resells none.',
    }),
    field('useProxy', {
      label: 'Use proxy',
    }),
    field('solverUrl', {
      label: 'Challenge-solver URL',
      kind: 'text',
      help: 'Optional self-hosted challenge-solver service (off unless set). Enabling it trusts the service as a content source.',
    }),
    field('hostedReaderUrl', {
      label: 'Hosted reader URL',
      kind: 'text',
      help: 'Optional third-party reader service (off unless set). Sends the target URL off-machine.',
    }),
    field('userAgent', {
      label: 'User-Agent',
      kind: 'text',
      help: 'Custom User-Agent header',
    }),
    field('daemonPort', {
      label: 'Daemon port',
      min: 1024,
      max: 65535,
    }),
    field('accountsUrl', {
      label: 'Accounts service URL',
      kind: 'text',
      help: 'Base URL of the account service used for sign-in, entitlements and telemetry. Leave unset to use the hosted wigolo accounts service; set it only to point this install at a self-hosted one.',
    }),
    field('telemetryEnabled', {
      label: 'Usage and reliability telemetry',
      // NOT "anonymous": every batch is authorised as your account, so the counters are
      // attributed to it. Claiming anonymity in the same sentence that says "to your
      // account" was the shipped wording and it contradicted itself.
      help: 'Send usage and reliability counters to your account: which tools ran, how long they took as coarse buckets, error classes, and the registrable domain of a blocked site. Never page content, queries, full URLs, credentials or file paths. Turn it off here, or set WIGOLO_TELEMETRY=off for a single run — off means nothing is queued and no counter reaches the wire.',
    }),
    field('daemonHost', {
      label: 'Daemon host',
      kind: 'text',
    }),
  ],
};
