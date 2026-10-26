import { describe, expect, it } from 'vitest'
import { defaultMachine, defaultMaterial, demoDesign } from './model'
import { emptyWorkspace, parseWorkspace, stockMaterials } from './workspace'
import { planJob } from './planner'
describe('material library', () => {
  it('seeds distinct 3 and 6 mm plywood/MDF drafts without claiming calibrated settings', () => {
    const materials = stockMaterials()
    expect(materials.map(m => [m.id, m.thickness, m.approved])).toEqual([['plywood-3mm', 3, false], ['plywood-6mm', 6, false], ['mdf-3mm', 3, false], ['mdf-6mm', 6, false]])
    expect(materials.filter(m => m.grainLocked).map(m => m.id)).toEqual(['plywood-3mm', 'plywood-6mm'])
    materials[0].cut.maxPower = 5
    expect(materials[1].cut.maxPower).not.toBe(5)
  })
  it('migrates an existing catalogue without losing settings, approval, or design routing', () => {
    const material = { ...defaultMaterial, approved: true, kerf: .22 }
    const migrated = parseWorkspace({ machine: defaultMachine, material, designs: [demoDesign] })
    expect(migrated.materials.find(m => m.id === material.id)).toEqual(material)
    expect(migrated.designs[0].materialId).toBe(material.id)
    expect(migrated.materials).toHaveLength(5)
    expect(parseWorkspace(migrated)).toEqual(migrated)
  })
  it('rejects duplicate SKUs and missing material references', () => {
    const workspace = emptyWorkspace(); workspace.designs = [demoDesign, { ...demoDesign, id: 'duplicate' }]
    expect(() => parseWorkspace(workspace)).toThrow('SKUs')
    workspace.designs = [{ ...demoDesign, materialId: 'missing' }]
    expect(() => parseWorkspace(workspace)).toThrow('missing material')
  })
  it('cannot prepare a mapped SKU using a different material', () => {
    const workspace = emptyWorkspace()
    expect(() => planJob({ reference: 'test', machine: workspace.machine, material: { ...workspace.materials[1], approved: true }, lines: [{ design: { ...demoDesign, approved: true, materialId: workspace.materials[0].id }, quantity: 1, order: 'test' }] })).toThrow('different material')
  })
})
