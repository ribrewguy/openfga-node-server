/**
 * Helpers for the DSL-accepting branch of POST
 * /stores/:storeId/authorization-models. The transformer module
 * itself is the @openfga/syntax-transformer package; this file just
 * wraps content-type detection and error formatting so the route
 * handler stays focused on the wire shape.
 */
import { errors as transformerErrors } from '@openfga/syntax-transformer'

/**
 * True when the Content-Type advertises an OpenFGA DSL body.
 *
 * `application/x-openfga-dsl` is the preferred type. `text/plain` is
 * accepted as a fallback because curl, ad-hoc scripts, and many
 * static-file servers default to it. Parameters such as
 * `; charset=utf-8` are tolerated per RFC 7231 §3.1.1.1.
 */
export function isDslContentType(header: string | undefined): boolean {
  if (!header) return false
  const type = header.split(';', 1)[0]!.trim().toLowerCase()
  return type === 'application/x-openfga-dsl' || type === 'text/plain'
}

/**
 * Render a transformer error as a client-facing message. The
 * transformer's syntax / validation errors carry zero-based line and
 * column information; this surfaces 1-based positions because that
 * is what almost every editor reports and what is least surprising
 * to a human reading the response.
 */
export function formatDslError(err: unknown): string {
  if (err instanceof transformerErrors.DSLSyntaxError && err.errors.length > 0) {
    const first = err.errors[0]!
    const line = first.line ? first.line.start + 1 : undefined
    const col = first.column ? first.column.start + 1 : undefined
    if (line !== undefined && col !== undefined) {
      return `DSL parse error at line ${line}, column ${col}: ${first.msg}`
    }
    return `DSL parse error: ${first.msg}`
  }
  if (err instanceof transformerErrors.ModelValidationError && err.errors.length > 0) {
    const first = err.errors[0]!
    const line = first.line ? first.line.start + 1 : undefined
    const col = first.column ? first.column.start + 1 : undefined
    if (line !== undefined && col !== undefined) {
      return `DSL validation error at line ${line}, column ${col}: ${first.msg}`
    }
    return `DSL validation error: ${first.msg}`
  }
  if (err instanceof Error) return `DSL error: ${err.message}`
  return 'DSL error'
}
