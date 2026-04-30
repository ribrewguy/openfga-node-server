/**
 * Storage interface the evaluator depends on.
 *
 * Pure dependency inversion — the evaluator doesn't know whether tuples
 * live in Postgres or in a Map. Production wires `TupleStore` to the
 * `storage/tuples.ts` repository; unit tests pass an in-memory
 * implementation so the evaluator can be exercised without I/O.
 */

export interface TupleStore {
  /** Users (direct, userset, or wildcard refs) directly assigned to (object, relation). */
  listUsersForRelation(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<string[]>

  /** Object_ids of `objectType` directly assigned to `userStr` via `relation`. */
  listObjectIdsForUser(
    objectType: string,
    relation: string,
    userStr: string,
  ): Promise<string[]>

  /** All (object_id, user_str) for (objectType, relation). For tupleToUserset reverse walks. */
  listAllForRelation(
    objectType: string,
    relation: string,
  ): Promise<Array<{ object_id: string, user_str: string }>>
}

/**
 * In-memory implementation. Test-only. Production code uses the
 * pg-backed implementation in `../storage/tuples.ts`.
 */
export class InMemoryTupleStore implements TupleStore {
  // Tuples stored as an array; queries are linear scans. Fine for tests.
  private tuples: Array<{
    object_type: string
    object_id: string
    relation: string
    user_str: string
  }> = []

  add(objectRef: string, relation: string, userStr: string): void {
    const idx = objectRef.indexOf(':')
    if (idx < 0) throw new Error(`Invalid object: ${objectRef}`)
    this.tuples.push({
      object_type: objectRef.slice(0, idx),
      object_id: objectRef.slice(idx + 1),
      relation,
      user_str: userStr,
    })
  }

  async listUsersForRelation(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<string[]> {
    return this.tuples
      .filter(t => t.object_type === objectType && t.object_id === objectId && t.relation === relation)
      .map(t => t.user_str)
  }

  async listObjectIdsForUser(
    objectType: string,
    relation: string,
    userStr: string,
  ): Promise<string[]> {
    const set = new Set<string>()
    for (const t of this.tuples) {
      if (t.object_type === objectType && t.relation === relation && t.user_str === userStr) {
        set.add(t.object_id)
      }
    }
    return [...set]
  }

  async listAllForRelation(
    objectType: string,
    relation: string,
  ): Promise<Array<{ object_id: string, user_str: string }>> {
    return this.tuples
      .filter(t => t.object_type === objectType && t.relation === relation)
      .map(t => ({ object_id: t.object_id, user_str: t.user_str }))
  }
}
