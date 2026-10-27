import type { Plan } from './model'
export interface ProductionOrderView {
  key: string; name: string; shop: string; status: 'on_bed' | 'released' | 'held' | 'ignored'; issues: string[]
  lines: { id: string; sku: string | null; quantity: number; allocated: number }[]; jobIds: string[]
}
export interface ProductionBatch {
  id: string; materialId: string; materialName: string; thickness: number; orderNames: string[]; componentCount: number; plan: Plan; layoutSlot: number
}
export interface ProductionView { batches: ProductionBatch[]; orders: ProductionOrderView[]; updatedAt: string }
export interface ShopifyStatus {
  configured: boolean; shop: string | null; enabled: boolean; syncing: boolean; pollSeconds: number
  lastAttempt: string | null; lastSuccess: string | null; error: string | null; nextAttempt: string | null
}
