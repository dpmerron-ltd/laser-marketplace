// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkshopStore } from './store'
import { ShopifySync } from './shopifySync'
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'laser-sync-')) })
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })
describe('automatic Shopify polling', () => {
  it('coalesces concurrent requests and persists sync/paused status across restarts', async () => {
    let done!: (value: { orders: []; unavailable: [] }) => void
    const reader = { shop: 'fixture.myshopify.com', read: vi.fn(() => new Promise<{ orders: []; unavailable: [] }>(resolve => { done = resolve })) }
    const sync = new ShopifySync(new WorkshopStore(root), reader)
    const first = sync.sync(), second = sync.sync()
    expect(reader.read).toHaveBeenCalledTimes(1); expect(sync.status().syncing).toBe(true)
    done({ orders: [], unavailable: [] }); await Promise.all([first, second])
    expect(sync.status().lastSuccess).toBeTruthy()
    sync.setEnabled(false)
    const restarted = new ShopifySync(new WorkshopStore(root), reader)
    expect(restarted.status().enabled).toBe(false); expect(restarted.status().lastSuccess).toBeTruthy()
  })
  it('polls automatically with bounded backoff and stops after pause', async () => {
    vi.useFakeTimers()
    const reader = { shop: 'fixture.myshopify.com', read: vi.fn().mockRejectedValue(new Error('Shopify unavailable')) }
    const sync = new ShopifySync(new WorkshopStore(root), reader, 60)
    sync.start(); await vi.advanceTimersByTimeAsync(0)
    expect(reader.read).toHaveBeenCalledTimes(1)
    expect(sync.status().lastSuccess).toBeNull(); expect(sync.status().error).toContain('unavailable')
    await vi.advanceTimersByTimeAsync(119999); expect(reader.read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); expect(reader.read).toHaveBeenCalledTimes(2)
    sync.setEnabled(false); await vi.advanceTimersByTimeAsync(600000); expect(reader.read).toHaveBeenCalledTimes(2)
    sync.stop()
  })
  it('does not start any requests when credentials are absent', async () => {
    const sync = new ShopifySync(new WorkshopStore(root), null)
    sync.start(); expect(sync.status().nextAttempt).toBeNull()
    await expect(sync.sync()).rejects.toThrow('not configured')
    sync.stop()
  })
})
