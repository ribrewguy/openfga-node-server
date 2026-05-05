/**
 * Process-wide pino logger.
 *
 * Level: `OPENFGA_LOG_LEVEL` env var, falls back to `info`. Accepts
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

const level = process.env['OPENFGA_LOG_LEVEL'] ?? 'info'

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

export const logger = pino({ level, transport })
