import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ShopifyStatus } from '../src/laser/productionTypes'
import { atomicJson } from './catalogue'
import { ProductionStore } from './production'
import { createShopifyReader, shopifyConfig, type OrderReader } from './shopifyReader'
import type { WorkshopStore } from './store'

export class ShopifySync {
  readonly production: ProductionStore
  private statusValue: ShopifyStatus
  private stateFile: string
  private pending: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private failures = 0
  constructor(store: WorkshopStore, private readonly reader: OrderReader | null, pollSeconds = 60, configError: string | null = null) {
    this.production = new ProductionStore(store, reader?.shop ?? null); this.stateFile = join(store.root, 'shopify-sync.json')
    const saved = existsSync(this.stateFile) ? JSON.parse(readFileSync(this.stateFile, 'utf8')) : {}
    this.statusValue = { configured: !!reader, shop: reader?.shop ?? null, enabled: saved.enabled !== false, syncing: false, pollSeconds, lastAttempt: null, lastSuccess: saved.shop === reader?.shop ? saved.lastSuccess ?? null : null, error: configError, nextAttempt: null }
  }
  static fromEnvironment(store: WorkshopStore) {
    try { const config = shopifyConfig(process.env); return new ShopifySync(store, config ? createShopifyReader(config) : null, config?.pollSeconds ?? 60) }
    catch (e) { return new ShopifySync(store, null, 60, e instanceof Error ? e.message : 'Invalid Shopify configuration') }
  }
  status(): ShopifyStatus { return { ...this.statusValue } }
  setEnabled(enabled: boolean) { this.statusValue.enabled = enabled; this.persist(); this.schedule(enabled ? 0 : null); return this.status() }
  private persist() { atomicJson(this.stateFile, { enabled: this.statusValue.enabled, shop: this.statusValue.shop, lastSuccess: this.statusValue.lastSuccess }) }
  start() { this.stopped = false; this.schedule(0) }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; this.statusValue.nextAttempt = null }
  private schedule(delay: number | null) {
    if (this.timer) clearTimeout(this.timer); this.timer = null; this.statusValue.nextAttempt = null
    if (delay === null || this.stopped || !this.reader || !this.statusValue.enabled) return
    this.statusValue.nextAttempt = new Date(Date.now() + delay).toISOString()
    this.timer = setTimeout(() => { this.timer = null; void this.sync().catch(() => { /* status records the failure */ }) }, delay)
    this.timer.unref?.()
  }
  async sync(): Promise<void> {
    if (this.pending) return this.pending
    if (!this.reader) throw new Error(this.statusValue.error ?? 'Shopify is not configured. Add the store and server credentials in .env.workshop, then restart the service.')
    this.statusValue.syncing = true; this.statusValue.lastAttempt = new Date().toISOString(); this.statusValue.nextAttempt = null
    const reader = this.reader
    this.pending = (async () => {
      try {
        const result = await reader.read(this.production.watchIds(reader.shop))
        this.production.ingest(reader.shop, result.orders, result.unavailable)
        this.statusValue.lastSuccess = new Date().toISOString(); this.statusValue.error = null; this.failures = 0; this.persist()
      } catch (e) { this.failures++; this.statusValue.error = e instanceof Error ? e.message : 'Shopify sync failed'; throw e }
      finally { this.statusValue.syncing = false; this.pending = null; this.schedule(Math.min(15 * 60000, this.statusValue.pollSeconds * 1000 * 2 ** Math.min(this.failures, 4))) }
    })()
    return this.pending
  }
}
