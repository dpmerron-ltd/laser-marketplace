import { describe, expect, it } from 'vitest'
import { buildArtifacts, previewSvg } from './artifacts'
import { compileSheet } from './controllers'
import { layoutSheets, withSheetDeadSpaces } from './deadSpace'
import { defaultMachine, defaultMaterial, demoDesign, type DeadSpace, type JobRequest } from './model'
import { planJob } from './planner'

const zone = (changes: Partial<DeadSpace> = {}): DeadSpace => ({ id: 'defect', label: 'Previous cutout', x: 60, y: 40, width: 60, height: 40, ...changes })
function fixture(): JobRequest {
  return structuredClone({ reference: 'Dead space test', machine: defaultMachine,
    material: { ...defaultMaterial, approved: true, sheetWidth: 220, sheetHeight: 150, spacing: 4 },
    lines: [{ design: { ...demoDesign, approved: true }, quantity: 30, order: 'ORDER-1' }] })
}
function checkLayout(request: JobRequest) {
  const plan = planJob(request), count = request.lines.reduce((n, l) => n + l.quantity, 0)
  expect(plan.sheets.flatMap(s => s.placements)).toHaveLength(count)
  expect(new Set(plan.sheets.flatMap(s => s.placements.map(p => p.id))).size).toBe(count)
  for (const sheet of plan.sheets) for (const [i, part] of sheet.placements.entries()) {
    const blockers = [...sheet.placements.slice(i + 1), ...(request.sheetDeadSpaces?.find(s => s.sheetNumber === sheet.number)?.zones ?? [])]
    for (const b of blockers) {
      const gap = request.material.spacing - 0.00001
      expect(part.x + part.width + gap <= b.x || b.x + b.width + gap <= part.x || part.y + part.height + gap <= b.y || b.y + b.height + gap <= part.y).toBe(true)
    }
    expect(part.x).toBeGreaterThanOrEqual(request.material.margin - .00001)
    expect(part.y).toBeGreaterThanOrEqual(request.material.margin - .00001)
    expect(part.x + part.width).toBeLessThanOrEqual(sheet.width - request.material.margin + .00001)
    expect(part.y + part.height).toBeLessThanOrEqual(sheet.height - request.material.margin + .00001)
  }
  return plan
}
describe('sheet-specific dead space', () => {
  it('nests around central and overlapping defects, preserves clearance and limits them to their sheet', () => {
    const request = withSheetDeadSpaces(fixture(), 1, [zone(), zone({ id: 'overlap', x: 80, y: 50 })])
    const before = structuredClone(request), plan = checkLayout(request)
    expect(request).toEqual(before)
    expect(plan.sheets[0].deadSpaces).toHaveLength(2)
    expect(plan.sheets.slice(1).every(s => !s.deadSpaces?.length)).toBe(true)
    expect(planJob(request)).toEqual(plan)
  })
  it('handles edge defects, thin slivers, multiple sheets, rotated parts and grain locks', () => {
    // Deterministic varied layouts exercise free-space subtraction without relying on its algorithm.
    for (let i = 0; i < 24; i++) {
      let request = fixture(); request.material.grainLocked = i % 2 === 0
      request = withSheetDeadSpaces(request, 1, [zone({ x: i % 3 ? (i * 31) % 160 : 0, y: (i * 17) % 110, width: i % 4 ? 45 : .1, height: 35 })])
      request = withSheetDeadSpaces(request, 2, [zone({ x: 170, y: 0, width: 50, height: 150 })])
      const plan = checkLayout(request)
      if (request.material.grainLocked) expect(plan.sheets.flatMap(s => s.placements).every(p => !p.rotated)).toBe(true)
    }
  })
  it('skips a completely unusable physical sheet without renumbering it or exporting an empty file', () => {
    const request = withSheetDeadSpaces(fixture(), 1, [zone({ x: 0, y: 0, width: 220, height: 150 })])
    const plan = checkLayout(request)
    expect(plan.sheets[0].number).toBe(2)
    expect(layoutSheets(plan)[0].number).toBe(1)
    expect(layoutSheets(plan)[0].placements).toEqual([])
    expect(buildArtifacts(plan).some(a => a.name.startsWith('sheet-1.'))).toBe(false)
    expect(buildArtifacts(plan).some(a => a.name === 'sheet-2.laser.json')).toBe(true)
    expect(planJob(withSheetDeadSpaces(request, 1, [])).sheets).toEqual(planJob(fixture()).sheets)
  })
  it('fits rotated-only usable regions and still rejects impossible component dimensions', () => {
    let request = fixture(); request.lines[0].quantity = 1
    request = withSheetDeadSpaces(request, 1, [zone({ x: 50, y: 0, width: 170, height: 150 })])
    expect(checkLayout(request).sheets[0].placements[0].rotated).toBe(true)
    request.material.grainLocked = true
    expect(checkLayout(request).sheets[0].number).toBe(2)
    request.material.sheetWidth = 25; request.sheetDeadSpaces = []
    expect(() => planJob(request)).toThrow('does not fit')
  })
  it('rejects invalid, duplicate or out-of-stock exclusions', () => {
    for (const invalid of [{ width: 0 }, { x: -1 }, { height: NaN }, { x: 200 }, { y: 130 }, { width: Infinity }]) {
      expect(() => planJob(withSheetDeadSpaces(fixture(), 1, [zone(invalid)]))).toThrow()
    }
    expect(() => planJob(withSheetDeadSpaces(fixture(), 0, [zone()]))).toThrow()
    expect(() => planJob(withSheetDeadSpaces(fixture(), 1, [zone(), zone()]))).toThrow('unique')
    expect(() => planJob({ ...fixture(), sheetDeadSpaces: [{ sheetNumber: 1, zones: [] }, { sheetNumber: 1, zones: [] }] })).toThrow('unique')
  })
  it('shows defects only as preview overlays and preserves controller paths with mirrored Ruida output', () => {
    const request = withSheetDeadSpaces(fixture(), 1, [zone({ label: '<bad & old cut>' })])
    request.machine.controller = 'ruida-rd'; request.machine.mirrorX = true; request.machine.mirrorY = true
    const plan = checkLayout(request), sheet = plan.sheets[0]
    expect(previewSvg(sheet)).toContain('&lt;bad &amp; old cut&gt;')
    expect(compileSheet(sheet, request.machine).decoded).toEqual(compileSheet({ ...sheet, deadSpaces: [] }, request.machine).decoded)
    const bytes = buildArtifacts(plan).find(a => a.name === 'plan.json')!.bytes
    expect(JSON.parse(new TextDecoder().decode(bytes)).request.sheetDeadSpaces).toEqual(request.sheetDeadSpaces)
  })
})
