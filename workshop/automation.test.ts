// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request } from 'node:http'
import { createWorkshopServer } from './server'
import { WorkshopStore } from './store'
import { ShopifySync } from './shopifySync'
import type { SourceOrder } from './shopifyReader'
import { emptyWorkspace } from '../src/laser/workspace'
import { demoDesign } from '../src/laser/model'
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'laser-automation-http-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
it('runs Shopify intake through HTTP, nests matched SKUs and freezes a production bed once', async () => {
  const store = new WorkshopStore(root), shop = 'fixture.myshopify.com'
  let orders: SourceOrder[] = [{ id: 'gid://shopify/Order/1', name: '#HTTP-1', shop, updatedAt: '2026-10-26T12:00:00Z', cancelledAt: null, closed: false, test: false, financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED', lines: [{ id: 'gid://shopify/LineItem/11', sku: 'PLY3', currentQuantity: 4, unfulfilledQuantity: 4 }] }]
  const sync = new ShopifySync(store, { shop, async read() { return { orders, unavailable: [] } } })
  const server = createWorkshopServer(store, 4318, undefined, sync)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port')
  const call = (path: string, method = 'GET', input?: unknown) => new Promise<{ status: number; data: any }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path: '/workshop-api/' + path, method, headers: { Host: '127.0.0.1:4318', 'X-Laser-Client': 'laser-marketplace', 'Content-Type': 'application/json' } }, response => {
      const chunks: Buffer[] = []; response.on('data', c => chunks.push(c)); response.on('end', () => resolve({ status: response.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()) }))
    }); req.on('error', reject); req.end(input === undefined ? undefined : JSON.stringify(input))
  })
  try {
    const workspace = emptyWorkspace(); workspace.materials[0].approved = true
    workspace.designs = [{ ...demoDesign, sku: 'PLY3', approved: true, materialId: 'plywood-3mm' }]
    expect((await call('workspace', 'PUT', workspace)).status).toBe(200)
    expect((await call('shopify/sync', 'POST', {})).status).toBe(200)
    const production = (await call('production')).data
    expect(production.batches).toHaveLength(1); expect(production.batches[0].componentCount).toBe(4)
    const released = await call(`production/batches/${production.batches[0].id}/release`, 'POST', {})
    expect(released.status).toBe(201)
    expect((await call('production')).data.batches).toHaveLength(0)
    expect((await call(`production/batches/${production.batches[0].id}/release`, 'POST', {})).data.id).toBe(released.data.id)
    expect((await call('jobs')).data).toHaveLength(1)
    orders = [{ ...orders[0], cancelledAt: '2026-10-26T12:01:00Z', updatedAt: '2026-10-26T12:01:00Z' }]
    const attempt = await call(`jobs/${released.data.id}/sheets/1/actions`, 'POST', { action: 'stage' })
    expect(attempt.status).toBe(400); expect(attempt.data.error).toContain('on hold')
    expect((await call(`production/jobs/${released.data.id}/cancel`, 'POST', { note: 'Cancelled in Shopify before any work' })).status).toBe(200)
    expect((await call('jobs')).data[0].sheets[0].state).toBe('cancelled')
  } finally { sync.stop(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
