/**
 * Kysely plugin that prepends a configured prefix to every table name
 * at query-compile time. Used on the SQLite path to apply
 * `OPENFGA_DB_NAMESPACE` (default `openfga`) so a logical query against
 * the `store` table compiles to `openfga_store`.
 *
 * The Postgres path applies the namespace via `db.withSchema(ns)`
 * (schema-qualified table names are native to Postgres). SQLite has no
 * schema concept, so a query-AST plugin is the cleanest equivalent.
 *
 * Edge cases:
 *   - Already-prefixed identifiers are skipped so the plugin is
 *     idempotent if a query somehow flows through twice.
 *   - Identifiers carrying an explicit schema (e.g. `'sqlite_master'`
 *     via SchemableIdentifierNode.schema) are skipped. The Database
 *     type uses unqualified logical names, so this only fires on
 *     defensive pass-through queries.
 */
import {
  type KyselyPlugin,
  OperationNodeTransformer,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type RootOperationNode,
  type SchemableIdentifierNode,
  TableNode,
  type UnknownRow,
} from 'kysely'

/**
 * Identifiers that look like table references but aren't physical
 * tables — `EXCLUDED` is the virtual row available inside ON CONFLICT
 * DO UPDATE in both Postgres and SQLite. Adding the namespace prefix
 * to these would emit `<ns>_excluded.col` which doesn't exist.
 */
const PREFIX_SKIP_IDENTIFIERS = new Set(['excluded'])

class TablePrefixTransformer extends OperationNodeTransformer {
  constructor(private readonly prefix: string) {
    super()
  }

  protected override transformTable(node: TableNode): TableNode {
    const transformed = super.transformTable(node)
    const ident: SchemableIdentifierNode = transformed.table
    if (ident.schema !== undefined) return transformed
    const original = ident.identifier.name
    if (PREFIX_SKIP_IDENTIFIERS.has(original.toLowerCase())) return transformed
    if (original.startsWith(this.prefix)) return transformed
    return TableNode.create(`${this.prefix}${original}`)
  }
}

export class TablePrefixPlugin implements KyselyPlugin {
  readonly #transformer: TablePrefixTransformer

  constructor(prefix: string) {
    this.#transformer = new TablePrefixTransformer(prefix)
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.#transformer.transformNode(args.node)
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result
  }
}
