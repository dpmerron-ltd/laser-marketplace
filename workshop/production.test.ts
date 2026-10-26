// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { demoDesign } from '../src/laser/model'
import { emptyWorkspace } from '../src/laser/workspace'
import { WorkshopStore } from './store'
import { ProductionStore } from './production'
import type { SourceOrder } from './shopifyReader'
import { prepareCatalogueOrder } from './catalogueOrders'
const shop = 'laser-fixture.myshopify.com'
let root: string, store: WorkshopStore, production: ProductionStore
function order(id = '1', sku = 'PLY3', quantity = 4): SourceOrder {
  return { id: `gid://shopify/Order/${id}`, name: `#${id}`, shop, updatedAt: '2026-10-26T12:00:00Z', cancelledAt: null, closed: false, test: false, financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED', lines: [{ id: `gid://shopify/LineItem/${id}1`, sku, currentQuantity: quantity, unfulfilledQuantity: quantity }] }
}
function workspace() {
  const value = emptyWorkspace()
  value.materials = value.materials.map(m => ({ ...m, approved: true }))
  value.designs = ['PLY3', 'PLY6', 'MDF3', 'MDF6'].map((sku, i) => ({ ...structuredClone(demoDesign), id: `design-${i}`, sku, materialId: value.materials[i].id, approved: true }))
  return value
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'laser-production-')); store = new WorkshopStore(root); production = new ProductionStore(store); production.catalogue.save(workspace()) })
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })
describe('Shopify orders to material beds', () => {
  it('combines matching orders on one bed and separates all four materials', () => {
    const result = production.ingest(shop, [order('1'), order('2'), order('3', 'PLY6'), order('4', 'MDF3'), order('5', 'MDF6')])
    expect(result.batches).toHaveLength(4)
    const ply3 = result.batches.find(b => b.materialId === 'plywood-3mm')!
    expect(ply3.componentCount).toBe(8); expect(ply3.orderNames).toEqual(['#1', '#2'])
    expect(ply3.plan.sheets).toHaveLength(1)
    for (const batch of result.batches) expect(batch.plan.request.lines.every(l => l.design.materialId === batch.materialId)).toBe(true)
    expect(store.list()).toHaveLength(0) // Drafts have geometry but do not stage or freeze jobs.
  })
  it('handles mixed-material orders, remaining quantities, large quantities and exact allocation', () => {
    const mixed = order('1', 'PLY3', 400)
    mixed.lines.push({ id: 'gid://shopify/LineItem/12', sku: 'MDF6', currentQuantity: 8, unfulfilledQuantity: 3 })
    const result = production.ingest(shop, [mixed])
    expect(result.batches.map(b => b.componentCount).sort((a, b) => a - b)).toEqual([3, 400])
    const batch = result.batches.find(b => b.materialId === 'plywood-3mm')!
    const job = production.release(batch.id)
    expect(store.plan(job.id)).toEqual(batch.plan)
    expect(production.view().batches.map(b => b.componentCount)).toEqual([3])
    expect(production.view().orders[0].lines[0].allocated).toBe(400)
  })
  it('holds unmatched SKUs, missing assignments and unapproved settings, then retries after a catalogue save', () => {
    let result = production.ingest(shop, [order('1', 'UNKNOWN'), order('2')])
    expect(result.orders.find(o => o.name === '#1')!.status).toBe('held')
    const ws = workspace(); ws.designs[0].materialId = null as unknown as string; production.catalogue.save(ws)
    result = production.view(); expect(result.batches).toHaveLength(0)
    expect(result.orders.find(o => o.name === '#2')!.issues.join()).toContain('material assignment')
    ws.designs[0].materialId = 'plywood-3mm'; ws.materials[0].approved = false; production.catalogue.save(ws)
    expect(production.view().orders.find(o => o.name === '#2')!.issues.join()).toContain('Approve')
    ws.materials[0].approved = true; production.catalogue.save(ws)
    expect(production.view().batches[0].componentCount).toBe(4)
  })
  it('never treats a partially mapped order as complete or releases its other lines silently', () => {
    const source = order(); source.lines.push({ id: 'gid://shopify/LineItem/12', sku: null, currentQuantity: 1, unfulfilledQuantity: 1 })
    const result = production.ingest(shop, [source])
    expect(result.orders[0].status).toBe('held'); expect(result.batches).toEqual([])
  })
  it('ignores unpaid, cancelled, test, held-fulfillment and fully fulfilled orders', () => {
    const cases: SourceOrder[] = [ { ...order('1'), financialStatus: 'PENDING' }, { ...order('2'), cancelledAt: '2026-10-26T12:30:00Z' }, { ...order('3'), test: true }, { ...order('4'), fulfillmentStatus: 'ON_HOLD' }, { ...order('5'), fulfillmentStatus: 'FULFILLED' } ]
    expect(production.ingest(shop, cases).batches).toEqual([])
  })
  it('does not duplicate beds or reservations on repeated sync, release retry or service restart', () => {
    const source = order(), first = production.ingest(shop, [source]).batches[0]
    expect(production.ingest(shop, [{ ...source, updatedAt: '2026-10-26T12:01:00Z' }]).batches[0].id).toBe(first.id)
    const job = production.release(first.id)
    expect(production.release(first.id).id).toBe(job.id)
    const restarted = new ProductionStore(new WorkshopStore(root))
    expect(restarted.ingest(shop, [source]).batches).toHaveLength(0)
    expect(store.list()).toHaveLength(1)
    expect(restarted.view().orders[0].lines[0].allocated).toBe(4)
  })
  it('recovers a crash after freezing files but before recording reservations', () => {
    const batch = production.ingest(shop, [order()]).batches[0]
    const prepare = store.prepare.bind(store)
    vi.spyOn(store, 'prepare').mockImplementationOnce((request, key) => { prepare(request, key); throw new Error('Simulated interruption') })
    expect(() => production.release(batch.id)).toThrow('interruption')
    const restarted = new ProductionStore(new WorkshopStore(root))
    expect(restarted.view().batches).toHaveLength(0)
    expect(restarted.view().orders[0].lines[0].allocated).toBe(4)
    expect(store.list()).toHaveLength(1)
  })
  it('rebuilds changed drafts and refuses a stale release request', () => {
    const source = order(), old = production.ingest(shop, [source]).batches[0]
    source.lines[0].currentQuantity = 2; source.lines[0].unfulfilledQuantity = 2; source.updatedAt = '2026-10-26T12:01:00Z'
    expect(production.ingest(shop, [source]).batches[0].componentCount).toBe(2)
    expect(() => production.release(old.id)).toThrow('changed')
    expect(production.ingest(shop, [{ ...source, cancelledAt: '2026-10-26T12:02:00Z', updatedAt: '2026-10-26T12:02:00Z' }]).batches).toEqual([])
  })
  it('holds frozen jobs on cancellation; cancelling an unstarted shared batch replans the other orders', async () => {
    const a = order('1'), b = order('2'), batch = production.ingest(shop, [a, b]).batches[0], job = production.release(batch.id)
    production.ingest(shop, [{ ...a, cancelledAt: '2026-10-26T12:01:00Z', updatedAt: '2026-10-26T12:01:00Z' }])
    await expect(store.act(job.id, 1, { action: 'stage' })).rejects.toThrow('on hold')
    const after = production.cancelUnstarted(job.id, 'Confirmed cancellation before staging')
    expect(store.get(job.id).sheets.every(s => s.state === 'cancelled')).toBe(true)
    expect(after.batches).toHaveLength(1); expect(after.batches[0].orderNames).toEqual(['#2'])
    expect(production.release(after.batches[0].id).id).not.toBe(job.id)
  })
  it('does not cancel or silently replace a batch after an operator starts it', async () => {
    const source = order(), job = production.release(production.ingest(shop, [source]).batches[0].id)
    await store.act(job.id, 1, { action: 'stage' }); await store.act(job.id, 1, { action: 'record-start', note: 'Observed start' })
    production.ingest(shop, [{ ...source, financialStatus: 'REFUNDED', updatedAt: '2026-10-26T12:01:00Z' }])
    expect(() => production.cancelUnstarted(job.id, 'Refund received')).toThrow('unstarted')
    expect(store.get(job.id).sheets[0].state).toBe('running')
    expect(production.view().batches).toEqual([])
  })
  it('holds missing tracked orders rather than assuming they no longer need attention', () => {
    const source = order(), job = production.release(production.ingest(shop, [source]).batches[0].id)
    const result = production.ingest(shop, [], [source.id])
    expect(result.orders[0].status).toBe('held'); expect(Object.keys(store.get(job.id).productionHolds!)).toHaveLength(1)
  })
  it('keeps watching orders and propagates holds through replacement jobs', async () => {
    const source = order('1', 'PLY3', 1), job = production.release(production.ingest(shop, [source]).batches[0].id)
    await store.act(job.id, 1, { action: 'stage' })
    await store.act(job.id, 1, { action: 'record-start', note: 'Observed simulation start' })
    await store.act(job.id, 1, { action: 'record-finish', note: 'Observed simulation finish' })
    await store.act(job.id, 1, { action: 'inspect', note: 'Rejected sample', accepted: [], rejected: store.plan(job.id).sheets[0].placements.map(p => p.id) })
    const replacement = store.replacements(job.id)
    expect(production.tracksJob(replacement.id)).toBe(true)
    const result = production.ingest(shop, [{ ...source, closed: true, updatedAt: '2026-10-26T12:01:00Z' }])
    expect(production.watchIds(shop)).toContain(source.id)
    expect(result.orders[0].jobIds).toContain(replacement.id)
    await expect(store.act(replacement.id, 1, { action: 'stage' })).rejects.toThrow('on hold')
  })
  it('splits the local SKU intake into material jobs and preserves first snapshots on retries', () => {
    const input = { reference: '#api', lines: [{ sku: 'PLY3', quantity: 2 }, { sku: 'MDF6', quantity: 3 }] }
    const jobs = prepareCatalogueOrder(store, input, 'api-order')
    expect(jobs).toHaveLength(2)
    const ws = workspace(); ws.designs[0].revision++; production.catalogue.save(ws)
    expect(prepareCatalogueOrder(store, input, 'api-order').map(j => j.id)).toEqual(jobs.map(j => j.id))
    expect(() => prepareCatalogueOrder(store, { ...input, reference: '#changed' }, 'api-order')).toThrow('different order')
  })
})
