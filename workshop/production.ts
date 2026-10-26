import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildArtifacts } from '../src/laser/artifacts'
import { canonical, type Design, type JobRequest, type Material, type QueueJob } from '../src/laser/model'
import { planJob } from '../src/laser/planner'
import type { ProductionBatch, ProductionOrderView, ProductionView } from '../src/laser/productionTypes'
import { atomicJson, Catalogue } from './catalogue'
import type { SourceOrder } from './shopifyReader'
import type { WorkshopStore } from './store'

const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex').slice(0, 24)
const orderKey = (o: Pick<SourceOrder, 'shop' | 'id'>) => `${o.shop}:${o.id}`
const fingerprint = (o: SourceOrder) => digest({ cancelledAt: o.cancelledAt, closed: o.closed, test: o.test, financialStatus: o.financialStatus, fulfillmentStatus: o.fulfillmentStatus, lines: [...o.lines].sort((a, b) => a.id.localeCompare(b.id)) })
interface Allocation { orderKey: string; lineId: string; quantity: number }
interface Reservation extends Allocation { jobId: string; fingerprint: string }
interface RecordEntry { order: SourceOrder; unavailable: boolean }
interface ReleaseIntent { batchId: string; request: JobRequest; allocations: Allocation[]; fingerprints: Record<string, string> }
interface State { schema: 1; generation: number; records: Record<string, RecordEntry>; reservations: Reservation[]; releases: Record<string, string>; intent?: ReleaseIntent }
interface Draft extends ProductionBatch { allocations: Allocation[] }
function eligibility(order: SourceOrder): string | null {
  if (order.test) return 'Test order — excluded from automatic production'
  if (order.cancelledAt) return 'Order cancelled in Shopify'
  if (order.closed) return 'Order closed in Shopify'
  if (order.financialStatus !== 'PAID') return `Payment is ${order.financialStatus ?? 'unknown'}; only paid orders enter beds automatically`
  if (!['UNFULFILLED', 'PARTIALLY_FULFILLED'].includes(order.fulfillmentStatus)) return `Fulfillment status ${order.fulfillmentStatus} is not eligible for automatic production`
  return null
}
export class ProductionStore {
  private state: State
  private file: string
  readonly catalogue: Catalogue
  constructor(private readonly store: WorkshopStore, private readonly activeShop: string | null = null) {
    this.file = join(store.root, 'production.json'); this.catalogue = new Catalogue(store.root)
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { schema: 1, generation: 1, records: {}, reservations: [], releases: {} }
    if (this.state.schema !== 1 || !Array.isArray(this.state.reservations) || !this.state.records || !this.state.releases) throw new Error('Production ledger is invalid; restore it from a backup before syncing')
    this.recoverRelease()
  }
  private save() { atomicJson(this.file, this.state) }
  tracksJob(jobId: string): boolean {
    const visited = new Set<string>()
    while (jobId && !visited.has(jobId)) { visited.add(jobId); if (this.state.reservations.some(r => r.jobId === jobId)) return true; jobId = this.store.get(jobId).sourceJobId ?? '' }
    return false
  }
  watchIds(shop: string): string[] {
    const jobs = new Map(this.store.list().map(job => [job.id, job]))
    const activeAncestors = new Set<string>()
    for (const job of jobs.values()) {
      if (job.sheets.every(sheet => ['complete', 'cancelled'].includes(sheet.state))) continue
      let id: string | undefined = job.id
      const visited = new Set<string>()
      while (id && !visited.has(id)) { visited.add(id); activeAncestors.add(id); id = jobs.get(id)?.sourceJobId }
    }
    return Object.entries(this.state.records).filter(([key, r]) => r.order.shop === shop && (this.state.reservations.some(a => a.orderKey === key && activeAncestors.has(a.jobId)) || !r.order.cancelledAt && !r.order.closed && r.order.lines.some(l => l.unfulfilledQuantity > 0))).map(([, r]) => r.order.id)
  }
  ingest(shop: string, orders: SourceOrder[], unavailable: string[] = []): ProductionView {
    for (const order of orders) {
      if (order.shop !== shop) throw new Error('Order belongs to a different Shopify store')
      const key = orderKey(order), existing = this.state.records[key]
      if (existing && Date.parse(existing.order.updatedAt) > Date.parse(order.updatedAt)) continue
      this.state.records[key] = { order, unavailable: false }
    }
    for (const id of unavailable) { const r = this.state.records[orderKey({ shop, id })]; if (r) r.unavailable = true }
    this.save()
    return this.view()
  }
  private recoverRelease() {
    const intent = this.state.intent
    if (!intent) return
    const job = this.store.prepare(intent.request, `production-${intent.batchId}`)
    if (!this.state.releases[intent.batchId]) {
      this.state.reservations.push(...intent.allocations.map(a => ({ ...a, jobId: job.id, fingerprint: intent.fingerprints[a.orderKey] })))
      this.state.releases[intent.batchId] = job.id
    }
    delete this.state.intent; this.save()
  }
  private drafts(): { batches: Draft[]; orders: ProductionOrderView[] } {
    const workspace = this.catalogue.read(), batches: Draft[] = [], views: ProductionOrderView[] = []
    const jobs = new Map(this.store.list().map(j => [j.id, j]))
    // A cancelled unstarted job releases all its allocations, including other orders sharing it.
    const retained = this.state.reservations.filter(a => !jobs.get(a.jobId)?.sheets.every(s => s.state === 'cancelled'))
    if (retained.length !== this.state.reservations.length) { this.state.reservations = retained; this.state.generation++; this.save() }
    const groups = new Map<string, { material: Material; lines: JobRequest['lines']; allocations: Allocation[]; vertices: number; sourceVertices: number; count: number }>()
    const desiredHolds = new Map<string, Record<string, string>>()
    const flush = (id: string) => {
      const group = groups.get(id)
      if (!group?.lines.length || !workspace) return
      const request: JobRequest = { reference: `Shopify · ${group.material.name}`.slice(0, 160), machine: workspace.machine, material: group.material, lines: group.lines }
      const plan = planJob(request); buildArtifacts(plan)
      const batchId = digest({ generation: this.state.generation, request, allocations: group.allocations })
      batches.push({ id: batchId, materialId: id, materialName: group.material.name, thickness: group.material.thickness, componentCount: group.count, orderNames: [...new Set(group.lines.map(l => l.order))], plan, allocations: group.allocations })
      groups.delete(id)
    }
    let plannedCount = 0, plannedVertices = 0
    const checked = new Map<string, { design: Design; material: Material; vertices: number; sourceVertices: number }>()
    for (const [key, record] of Object.entries(this.state.records).sort(([a], [b]) => a.localeCompare(b))) {
      const { order } = record, reservations = this.state.reservations.filter(r => r.orderKey === key)
      const allocated = (lineId: string) => reservations.filter(a => a.lineId === lineId).reduce((n, a) => n + a.quantity, 0)
      const view: ProductionOrderView = { key, name: order.name, shop: order.shop, status: 'ignored', issues: [], jobIds: [...new Set(reservations.map(r => r.jobId))], lines: order.lines.map(l => ({ id: l.id, sku: l.sku, quantity: Math.min(l.currentQuantity, l.unfulfilledQuantity), allocated: allocated(l.id) })) }
      for (const job of jobs.values()) {
        let parent = job.sourceJobId; const visited = new Set<string>()
        while (parent && !visited.has(parent)) { visited.add(parent); if (view.jobIds.includes(parent)) { if (!view.jobIds.includes(job.id)) view.jobIds.push(job.id); break } parent = jobs.get(parent)?.sourceJobId }
      }
      views.push(view)
      if (this.activeShop && order.shop !== this.activeShop) { view.status = 'held'; view.issues.push('Reconnect this order’s Shopify store before preparing or releasing its production beds.'); for (const jobId of view.jobIds) { const holds = desiredHolds.get(jobId) ?? {}; holds[key] = `${order.name}: reconnect its Shopify store`; desiredHolds.set(jobId, holds) } continue }
      const changed = reservations.some(a => a.fingerprint !== fingerprint(order))
      if (changed || record.unavailable) {
        view.status = 'held'; view.issues.push(record.unavailable ? 'Order could not be verified in Shopify. Check access or whether it was deleted.' : 'Order quantities or production status changed after release. Review the frozen jobs before producing more.')
        for (const jobId of view.jobIds) {
          const holds = desiredHolds.get(jobId) ?? {}; holds[key] = `${order.name}: ${view.issues[0]}`; desiredHolds.set(jobId, holds)
        }
        continue
      }
      const excluded = eligibility(order)
      if (excluded) { view.issues.push(excluded); continue }
      const pending = view.lines.filter(l => l.quantity > l.allocated)
      if (!pending.length) { view.status = reservations.length ? 'released' : 'ignored'; continue }
      if (!workspace) { view.status = 'held'; view.issues.push('Save the design catalogue and material library to the workshop first'); continue }
      if (pending.reduce((n, l) => n + l.quantity - l.allocated, 0) > 5000) { view.status = 'held'; view.issues.push('Order exceeds 5,000 components; split it into smaller production orders'); continue }
      const resolved: { lineId: string; quantity: number; design: Design; material: Material; vertices: number; sourceVertices: number }[] = []
      for (const line of pending) {
        try {
          if (!line.sku?.trim()) throw new Error('Line item has no SKU')
          const design = workspace.designs.find(d => d.sku === line.sku!.trim())
          if (!design) throw new Error(`SKU ${line.sku} is not in the design library`)
          if (!design.materialId) throw new Error(`SKU ${line.sku} needs a material assignment`)
          const material = workspace.materials.find(m => m.id === design.materialId)
          if (!material) throw new Error(`SKU ${line.sku} refers to a missing material`)
          let validated = checked.get(design.id)
          if (!validated) {
            const sample = planJob({ reference: 'Validation', machine: workspace.machine, material, lines: [{ design, quantity: 1, order: order.name }] })
            buildArtifacts(sample)
            validated = { design, material, vertices: sample.sheets.flatMap(s => s.paths).reduce((n, p) => n + p.points.length * p.settings.passes, 0), sourceVertices: design.paths.reduce((n, p) => n + p.points.length, 0) }
            if (validated.vertices > 250000 || validated.sourceVertices > 50000) throw new Error('This design exceeds production batch limits; simplify its geometry')
            checked.set(design.id, validated)
          }
          resolved.push({ lineId: line.id, quantity: line.quantity - line.allocated, ...validated })
        } catch (error) { view.issues.push(`${line.sku ?? line.id}: ${error instanceof Error ? error.message : 'Cannot plan this SKU'}`) }
      }
      if (view.issues.length) { view.status = 'held'; continue }
      if (plannedCount + resolved.reduce((n, r) => n + r.quantity, 0) > 5000 || plannedVertices + resolved.reduce((n, r) => n + r.quantity * r.vertices, 0) > 500000) { view.status = 'held'; view.issues.push('Draft planning capacity reached (5,000 components / 500,000 vertices). Release existing batches or split this order.'); continue }
      view.status = 'on_bed'
      for (const item of resolved) {
        let remaining = item.quantity
        while (remaining > 0) {
          let group = groups.get(item.material.id)
          if (!group) { group = { material: item.material, lines: [], allocations: [], vertices: 0, sourceVertices: 0, count: 0 }; groups.set(item.material.id, group) }
          const quantity = Math.min(remaining, 200, 500 - group.count, Math.floor((250000 - group.vertices) / Math.max(1, item.vertices)))
          if (quantity <= 0 || group.lines.length >= 100 || group.sourceVertices + item.sourceVertices > 50000) { flush(item.material.id); continue }
          group.lines.push({ design: item.design, quantity, order: order.name })
          group.allocations.push({ orderKey: key, lineId: item.lineId, quantity })
          group.count += quantity; group.vertices += quantity * item.vertices; group.sourceVertices += item.sourceVertices
          remaining -= quantity; plannedCount += quantity; plannedVertices += quantity * item.vertices
        }
      }
    }
    for (const id of [...groups.keys()].sort()) flush(id)
    for (const job of jobs.values()) {
      const desired = desiredHolds.get(job.id) ?? {}
      // Only the production subsystem owns this field. File bytes and run history stay unchanged.
      if (canonical(job.productionHolds ?? {}) !== canonical(desired)) this.store.setProductionHolds(job.id, desired)
    }
    return { batches, orders: views }
  }
  view(): ProductionView {
    this.recoverRelease()
    const result = this.drafts()
    return { batches: result.batches.map(({ allocations: _allocations, ...batch }) => batch), orders: result.orders, updatedAt: new Date().toISOString() }
  }
  release(batchId: string): QueueJob {
    this.recoverRelease()
    if (this.state.releases[batchId]) return this.store.get(this.state.releases[batchId])
    const draft = this.drafts().batches.find(b => b.id === batchId)
    if (!draft) throw new Error('This draft bed changed. Refresh the production beds before releasing it.')
    this.state.intent = { batchId, request: draft.plan.request, allocations: draft.allocations, fingerprints: Object.fromEntries(draft.allocations.map(a => [a.orderKey, fingerprint(this.state.records[a.orderKey].order)])) }
    this.save(); this.recoverRelease()
    return this.store.get(this.state.releases[batchId])
  }
  cancelUnstarted(jobId: string, note: string): ProductionView {
    if (!this.tracksJob(jobId)) throw new Error('This job is not a Shopify production batch')
    this.store.cancelUnstarted(jobId, note)
    return this.view()
  }
}
