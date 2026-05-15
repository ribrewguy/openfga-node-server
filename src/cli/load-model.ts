/**
 * Model loader CLI — reads an OpenFGA DSL file and writes it as a new
 * authorization model on the running server.
 *
 * Unlike the OpenFGA reference server, this server does NOT auto-load
 * a model on startup. Models are written via the standard
 * `POST /stores/:storeId/authorization-models` endpoint, which this
 * CLI invokes.
 *
 * Usage:
 *   pnpm load-model <path-to-model.fga>
 *
 * Required env:
 *   OPENFGA_API_URL   Base URL of the running server. Default http://localhost:8080.
 *   OPENFGA_STORE_ID  Existing store id. If unset, a new store is created and printed.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { transformer } from '@openfga/syntax-transformer'
import { config } from '../config'

const API = config.loadModel.apiUrl
const STORE_NAME = config.loadModel.storeName

async function main() {
  const dslPath = process.argv[2]
  if (!dslPath) {
    console.error('Usage: pnpm load-model <path-to-model.fga>')
    process.exit(1)
  }

  const dsl = readFileSync(resolve(process.cwd(), dslPath), 'utf8')
  const modelJson = transformer.transformDSLToJSONObject(dsl)

  let storeId = config.loadModel.storeId
  if (!storeId) {
    const res = await fetch(`${API}/stores`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: STORE_NAME }),
    })
    if (!res.ok) {
      console.error(`Failed to create store: ${res.status} ${await res.text()}`)
      process.exit(1)
    }
    const created = (await res.json()) as { id: string }
    storeId = created.id
    console.log(`Created store ${storeId}`)
    console.log(`\n  Set in your environment:\n  OPENFGA_STORE_ID=${storeId}\n`)
  }

  const res = await fetch(`${API}/stores/${storeId}/authorization-models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(modelJson),
  })
  if (!res.ok) {
    console.error(`Failed to write model: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  const { authorization_model_id } = (await res.json()) as { authorization_model_id: string }
  console.log(`Loaded model ${authorization_model_id}`)
  console.log(`\n  Pin (optional, latest is used by default):\n  OPENFGA_MODEL_ID=${authorization_model_id}\n`)
}

main().catch((err) => {
  console.error('Load failed:', err)
  process.exit(1)
})
