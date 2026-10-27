import { z } from 'zod'

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
const name = z.string().trim().min(1).max(160)
const mm = z.number().finite().positive().max(10000)
export const pointSchema = z.object({ x: z.number().finite().min(-10000).max(10000), y: z.number().finite().min(-10000).max(10000) })
export const pathSchema = z.object({
  id, layer: name, operation: z.enum(['cut', 'score', 'ignore']), closed: z.boolean(),
  points: z.array(pointSchema).min(2).max(12000),
})
export const designSchema = z.object({
  id, revision: z.number().int().positive(), name, sku: name, approved: z.boolean(),
  sourceName: name, sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  materialId: id.nullable().optional(),
  allowRotation: z.boolean(), paths: z.array(pathSchema).min(1).max(250),
}).refine(d => new Set(d.paths.map(p => p.id)).size === d.paths.length, 'Path IDs must be unique within a design')
export const operationSchema = z.object({
  speedMmS: z.number().finite().min(0.1).max(1000),
  minPower: z.number().finite().min(0).max(100), maxPower: z.number().finite().min(0).max(100),
  passes: z.number().int().min(1).max(10), airAssist: z.boolean(),
}).refine(p => p.minPower <= p.maxPower, 'Minimum power must not exceed maximum power')
export const machineSchema = z.object({
  id, revision: z.number().int().positive(), name,
  controller: z.enum(['simulation', 'ruida-rd']), controllerModel: z.string().max(160),
  bedWidth: mm, bedHeight: mm, origin: z.literal('top-left'),
  mirrorX: z.boolean(), mirrorY: z.boolean(), maxPower: z.number().finite().min(0).max(100),
})
export const materialSchema = z.object({
  id, revision: z.number().int().positive(), name, machineId: id, machineRevision: z.number().int().positive(), approved: z.boolean(),
  thickness: mm, sheetWidth: mm, sheetHeight: mm,
  kerf: z.number().finite().min(0).max(2), margin: z.number().finite().min(0).max(500),
  spacing: z.number().finite().min(0.1).max(500), grainLocked: z.boolean(),
  cut: operationSchema, score: operationSchema, notes: z.string().max(4000),
})
export const deadSpaceSchema = z.object({
  id, label: name,
  x: z.number().finite().min(0).max(10000), y: z.number().finite().min(0).max(10000),
  width: mm, height: mm,
})
export const sheetDeadSpacesSchema = z.array(z.object({
  sheetNumber: z.number().int().min(1).max(1000), zones: z.array(deadSpaceSchema).max(50),
})).max(100).superRefine((sheets, ctx) => {
  if (new Set(sheets.map(s => s.sheetNumber)).size !== sheets.length) ctx.addIssue({ code: 'custom', message: 'Dead space sheet numbers must be unique' })
  if (sheets.reduce((n, s) => n + s.zones.length, 0) > 500) ctx.addIssue({ code: 'custom', message: 'A batch is limited to 500 dead spaces' })
  for (const sheet of sheets) if (new Set(sheet.zones.map(z => z.id)).size !== sheet.zones.length) ctx.addIssue({ code: 'custom', message: 'Dead space IDs must be unique on each sheet' })
})
export const requestSchema = z.object({
  reference: name, machine: machineSchema, material: materialSchema,
  sheetDeadSpaces: sheetDeadSpacesSchema.optional(),
  lines: z.array(z.object({ design: designSchema, quantity: z.number().int().min(1).max(200), order: name })).min(1).max(100),
}).superRefine((v, ctx) => {
  if (v.lines.reduce((n, l) => n + l.quantity, 0) > 500) ctx.addIssue({ code: 'custom', message: 'A batch is limited to 500 components' })
  if (v.lines.reduce((n, l) => n + l.design.paths.reduce((s, p) => s + p.points.length, 0), 0) > 50000) ctx.addIssue({ code: 'custom', message: 'Batch source geometry exceeds 50,000 points' })
  for (const sheet of v.sheetDeadSpaces ?? []) for (const zone of sheet.zones) {
    if (zone.x + zone.width > v.material.sheetWidth || zone.y + zone.height > v.material.sheetHeight) ctx.addIssue({ code: 'custom', message: `Dead space ${zone.label} on sheet ${sheet.sheetNumber} extends outside the stock sheet` })
  }
})
export type DeadSpace = z.infer<typeof deadSpaceSchema>
export type SheetDeadSpaces = z.infer<typeof sheetDeadSpacesSchema>
export type Point = z.infer<typeof pointSchema>
export type VectorPath = z.infer<typeof pathSchema>
export type Design = z.infer<typeof designSchema>
export type Machine = z.infer<typeof machineSchema>
export type Material = z.infer<typeof materialSchema>
export type Settings = z.infer<typeof operationSchema>
export type JobRequest = z.infer<typeof requestSchema>
export interface PlannedPath { id: string; instanceId: string; operation: 'cut' | 'score'; points: Point[]; closed: boolean; depth: number; settings: Settings }
export interface Placement { id: string; sku: string; name: string; order: string; designId: string; revision: number; x: number; y: number; width: number; height: number; rotated: boolean }
export interface Sheet { number: number; width: number; height: number; deadSpaces?: DeadSpace[]; placements: Placement[]; paths: PlannedPath[]; travelMm: number; cutMm: number; estimatedSeconds: number }
export interface Plan { schema: 'laser-plan/v1'; plannerVersion: string; request: JobRequest; sheets: Sheet[]; warnings: string[] }
export type SheetState = 'ready' | 'transferring' | 'staged' | 'running' | 'awaiting_inspection' | 'complete' | 'needs_reconciliation' | 'cancelled'
export interface SheetStatus { number: number; state: SheetState; accepted: string[]; rejected: string[]; receipt?: string }
export interface QueueJob { sourceJobId?: string; productionHolds?: Record<string, string>; materialName?: string; thickness?: number; id: string; reference: string; createdAt: string; controller: Machine['controller']; sheets: SheetStatus[]; artifactHash: string; events: { at: string; sheet: number; action: string; note: string }[] }

// Deliberately unapproved examples: these are demonstration values, not cutting recommendations.
export const defaultMachine: Machine = { id: 'workshop-laser', revision: 1, name: 'Workshop laser', controller: 'simulation', controllerModel: 'Not commissioned', bedWidth: 600, bedHeight: 400, origin: 'top-left', mirrorX: false, mirrorY: false, maxPower: 70 }
export const defaultMaterial: Material = { id: 'sample-stock', revision: 1, name: 'Sample stock — configure before use', machineId: 'workshop-laser', machineRevision: 1, approved: false, thickness: 3, sheetWidth: 600, sheetHeight: 400, kerf: 0.15, margin: 10, spacing: 3, grainLocked: false, cut: { speedMmS: 15, minPower: 20, maxPower: 30, passes: 1, airAssist: true }, score: { speedMmS: 100, minPower: 5, maxPower: 10, passes: 1, airAssist: true }, notes: 'Example only. Replace with measured kerf and verified speed/power for this machine and stock.' }
export const demoDesign: Design = { id: 'sample-tag', revision: 1, name: 'Sample tag 60 × 30 mm', sku: 'TAG-60', approved: false, sourceName: 'built-in-sample', sourceHash: '0'.repeat(64), allowRotation: true, paths: [
  { id: 'outline', layer: 'Outline', operation: 'cut', closed: true, points: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 30 }, { x: 0, y: 30 }] },
  { id: 'hole', layer: 'Hole', operation: 'cut', closed: true, points: Array.from({ length: 32 }, (_, i) => ({ x: 7 + 2 * Math.cos(i * Math.PI / 16), y: 15 + 2 * Math.sin(i * Math.PI / 16) })) },
  { id: 'score', layer: 'Score', operation: 'score', closed: false, points: [{ x: 15, y: 15 }, { x: 50, y: 15 }] },
] }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}'
  return JSON.stringify(value)
}
export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))).map(b => b.toString(16).padStart(2, '0')).join('')
}
