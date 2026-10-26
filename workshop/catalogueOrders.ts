import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { canonical, type JobRequest } from '../src/laser/model'
import { planJob } from '../src/laser/planner'
import { buildArtifacts } from '../src/laser/artifacts'
import { Catalogue, atomicJson } from './catalogue'
import type { WorkshopStore } from './store'
const schema = z.object({ reference: z.string().trim().min(1).max(160), lines: z.array(z.object({ sku: z.string().trim().min(1), quantity: z.number().int().min(1).max(200), order: z.string().trim().min(1).max(160).optional() })).min(1).max(100) }).refine(o => o.lines.reduce((n, l) => n + l.quantity, 0) <= 500, 'A manual batch is limited to 500 components')
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
export function prepareCatalogueOrder(store: WorkshopStore, raw: unknown, key: string) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(key)) throw new Error('Provide an Idempotency-Key containing 1–120 letters, numbers, hyphens or underscores')
  const input = schema.parse(raw), inputHash = hash(canonical(input)), id = hash(key), root = join(store.root, 'catalogue-orders'), file = join(root, `${id}.json`)
  let requests: JobRequest[]
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    if (saved.inputHash !== inputHash) throw new Error('Idempotency key already belongs to a different order')
    requests = saved.requests
  } else {
    const workspace = new Catalogue(store.root).read()
    if (!workspace) throw new Error('Save the catalogue and material library to the workshop first')
    const groups = new Map<string, JobRequest>()
    for (const line of input.lines) {
      const design = workspace.designs.find(d => d.sku === line.sku)
      if (!design) throw new Error(`Unknown SKU ${line.sku}`)
      if (!design.materialId) throw new Error(`SKU ${line.sku} needs a material assignment`)
      const material = workspace.materials.find(m => m.id === design.materialId)!
      const group = groups.get(material.id) ?? { reference: input.reference, machine: workspace.machine, material, lines: [] }
      group.lines.push({ design, quantity: line.quantity, order: line.order ?? input.reference }); groups.set(material.id, group)
    }
    requests = [...groups.values()]
    for (const request of requests) buildArtifacts(planJob(request))
    mkdirSync(root, { recursive: true, mode: 0o700 }); atomicJson(file, { inputHash, requests })
  }
  return requests.map((request, i) => store.prepare(request, `catalogue-${id}-${i}`))
}
