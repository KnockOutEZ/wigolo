import type { CategoryDef } from './types.js';

export const advancedCategory: CategoryDef = {
  id: 'advanced',
  label: 'Advanced',
  description: 'Logging, proxy, daemon host/port',
  fields: [
    {
      key: 'WIGOLO_LOG_LEVEL',
      settingsPath: 'logLevel',
      label: 'Log level',
      kind: 'select',
      options: [
        { value: 'debug', label: 'debug' },
        { value: 'info', label: 'info' },
        { value: 'warn', label: 'warn' },
        { value: 'error', label: 'error' },
      ],
      default: 'info',
    },
    {
      key: 'PROXY_URL',
      settingsPath: 'proxyUrl',
      label: 'Proxy URL',
      kind: 'text',
      help: 'HTTP proxy URL',
    },
    {
      key: 'USE_PROXY',
      settingsPath: 'useProxy',
      label: 'Use proxy',
      kind: 'toggle',
      default: false,
    },
    {
      key: 'WIGOLO_SOLVER_URL',
      settingsPath: 'solverUrl',
      label: 'Challenge-solver URL',
      kind: 'text',
      help: 'Optional self-hosted challenge-solver service (off unless set). Enabling it trusts the service as a content source.',
    },
    {
      key: 'WIGOLO_HOSTED_READER_URL',
      settingsPath: 'hostedReaderUrl',
      label: 'Hosted reader URL',
      kind: 'text',
      help: 'Optional third-party reader service (off unless set). Sends the target URL off-machine.',
    },
    {
      key: 'USER_AGENT',
      settingsPath: 'userAgent',
      label: 'User-Agent',
      kind: 'text',
      help: 'Custom User-Agent header',
    },
    {
      key: 'WIGOLO_DAEMON_PORT',
      settingsPath: 'daemonPort',
      label: 'Daemon port',
      kind: 'number',
      default: 7777,
      min: 1024,
      max: 65535,
    },
    {
      key: 'WIGOLO_DAEMON_HOST',
      settingsPath: 'daemonHost',
      label: 'Daemon host',
      kind: 'text',
      default: '127.0.0.1',
    },
  ],
};
