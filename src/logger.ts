/**
 * Process-wide pino logger.
 *
 * Level comes from the resolved configuration's `log.level` field
 * (env var `OPENFGA_LOG_LEVEL` overrides the configured value via
 * the same path; see `docs/features/configuration.md`). Accepts
 * pino's standard levels: `trace`, `debug`, `info`, `warn`, `error`,
 * `fatal`, or `silent`.
 *
 * Output format:
 * - `process.stdout.isTTY` (running interactively, e.g. `pnpm dev`)
 *   → human-readable colored output via pino-pretty.
 * - Otherwise (piped to a file, container stdout, CI) → raw JSON,
 *   one event per line — consumable by any log aggregator.
 *
 * pino-pretty is a devDep; it's only loaded when stdout is a TTY,
 * which is only true in dev. Production deployments stream JSON.
 */
import pino from 'pino'
import { config } from './config'

const transport = process.stdout.isTTY
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    }
  : undefined

export const logger = pino({ level: config.log.level, transport })
