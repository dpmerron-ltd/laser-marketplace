import { z } from 'zod'
import { defaultMachine, defaultMaterial, designSchema, machineSchema, materialSchema, type Machine, type Material } from './model'

export function stockMaterials(machine: Machine = defaultMachine): Material[] {
  return (['Plywood', 'MDF'] as const).flatMap(kind => [3, 6].map(thickness => ({
    ...structuredClone(defaultMaterial), id: `${kind.toLowerCase()}-${thickness}mm`, name: `${kind} · ${thickness} mm`,
    machineId: machine.id, machineRevision: machine.revision, thickness,
    sheetWidth: machine.bedWidth, sheetHeight: machine.bedHeight, grainLocked: kind === 'Plywood',
    notes: `${thickness} mm ${kind.toLowerCase()}. Draft cutting settings only; measure kerf and calibrate speed, power and passes on this machine before approval.`,
  })))
}
export const workspaceSchema = z.object({
  schema: z.literal('laser-workspace/v2'), machine: machineSchema,
  materials: z.array(materialSchema).min(1).max(100), activeMaterialId: z.string(),
  designs: z.array(designSchema).max(1000),
}).superRefine((w, ctx) => {
  for (const [label, values] of [['Material IDs', w.materials.map(m => m.id)], ['Design IDs', w.designs.map(d => d.id)], ['Catalogue SKUs', w.designs.map(d => d.sku)]] as const) {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: `${label} must be unique` })
  }
  if (!w.materials.some(m => m.id === w.activeMaterialId)) ctx.addIssue({ code: 'custom', message: 'Selected material is missing from the library' })
  if (w.designs.some(d => d.materialId && !w.materials.some(m => m.id === d.materialId))) ctx.addIssue({ code: 'custom', message: 'A design refers to a missing material profile' })
})
export type Workspace = z.infer<typeof workspaceSchema>
export function emptyWorkspace(): Workspace {
  return { schema: 'laser-workspace/v2', machine: structuredClone(defaultMachine), materials: stockMaterials(), activeMaterialId: 'plywood-3mm', designs: [] }
}
export function parseWorkspace(value: unknown): Workspace {
  const current = workspaceSchema.safeParse(value)
  if (current.success) return current.data
  // Preserve earlier drafts and custom settings. Never overwrite an approved legacy profile with a seed.
  const legacy = z.object({ machine: machineSchema, material: materialSchema, designs: z.array(designSchema).max(1000) }).safeParse(value)
  if (!legacy.success) return workspaceSchema.parse(value)
  const { machine, material, designs } = legacy.data
  return workspaceSchema.parse({ schema: 'laser-workspace/v2', machine,
    materials: [material, ...stockMaterials(machine).filter(m => m.id !== material.id)], activeMaterialId: material.id,
    designs: designs.map(d => ({ ...d, materialId: d.materialId ?? material.id })),
  })
}
