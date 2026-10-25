import { describe, expect, it, beforeAll, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { buildArtifacts, cuttingList } from './artifacts'
import { compileSheet } from './controllers'
import { ruidaAdapter, scramble, unscramble } from './controllers/ruida'
import { bounds, validatePaths } from './geometry'
import { importDesign } from './import'
import { defaultMachine, defaultMaterial, demoDesign, type JobRequest } from './model'
import { planJob } from './planner'
beforeAll(() => { vi.stubGlobal('crypto', webcrypto) })
export function fixture(): JobRequest {
  return structuredClone({ reference: 'ORDER-1', machine: defaultMachine, material: { ...defaultMaterial, approved: true }, lines: [{ design: { ...demoDesign, approved: true }, quantity: 3, order: 'ORDER-1' }] })
}
describe('laser planning', () => {
  it('compensates outlines outward and holes inward without changing source geometry', () => {
    const input = fixture(), snapshot = structuredClone(input), plan = planJob(input), sheet = plan.sheets[0]
    expect(input).toEqual(snapshot)
    expect(sheet.placements).toHaveLength(3)
    const outer = sheet.paths.find(p => p.id === 'line-1-part-1-outline')!, hole = sheet.paths.find(p => p.id === 'line-1-part-1-hole')!
    expect(Math.max(bounds(outer.points).width, bounds(outer.points).height)).toBeCloseTo(60.15, 3)
    expect(bounds(hole.points).width).toBeCloseTo(3.8492, 2)
    expect(hole.depth).toBe(1)
    expect(sheet.paths.indexOf(hole)).toBeLessThan(sheet.paths.indexOf(outer))
    expect(sheet.paths.slice(0, 3).every(p => p.operation === 'score')).toBe(true)
  })
  it('expands passes in native motion, roundtrips power, speed, air, and mirrored coordinates', () => {
    const input = fixture(); input.machine.controller = 'ruida-rd'; input.machine.mirrorX = true; input.machine.mirrorY = true
    input.material.cut.passes = 2; input.material.score.airAssist = false
    const sheet = planJob(input).sheets[0], compiled = compileSheet(sheet, input.machine)
    expect(compiled.bytes).toBeInstanceOf(Uint8Array)
    expect(compiled.decoded.filter(m => !m.burn)).toHaveLength(15)
    expect(compiled.decoded[0].to.x).toBeCloseTo(input.machine.bedWidth - sheet.paths[0].points[0].x, 3)
    expect(compiled.decoded[0].settings.airAssist).toBe(false)
    expect(compiled.decoded.at(-1)!.settings.minPower).toBeCloseTo(input.material.cut.minPower, 2)
    const broken = new Uint8Array(compiled.bytes); broken[broken.length - 2] ^= 1
    expect(() => ruidaAdapter.inspect(broken)).toThrow()
    expect(() => ruidaAdapter.inspect(compiled.bytes.slice(0, -1))).toThrow('Incomplete')
  })
  it('keeps geometry identical when the controller changes', () => {
    const input = fixture(), simulation = planJob(input)
    input.machine.controller = 'ruida-rd'
    const native = planJob(input)
    expect(native.sheets).toEqual(simulation.sheets)
    expect(buildArtifacts(native).some(a => a.name === 'sheet-1.rd')).toBe(true)
    expect(buildArtifacts(simulation).some(a => a.name === 'sheet-1.laser.json')).toBe(true)
  })
  it('requires explicit approval and matching machine revisions', () => {
    const input = fixture(); input.material.approved = false
    expect(() => planJob(input)).toThrow('Approve')
    input.material.approved = true; input.machine.revision++
    expect(() => planJob(input)).toThrow('machine revision')
  })
  it('rejects open cuts, duplicated contours, self intersections and touching cuts', () => {
    const paths = fixture().lines[0].design.paths
    expect(() => validatePaths([{ ...paths[0], closed: false }])).toThrow('closed')
    expect(() => validatePaths([paths[0], { ...paths[0], id: 'duplicate', points: [...paths[0].points].reverse() }])).toThrow('duplicate')
    expect(() => validatePaths([{ ...paths[0], points: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }] }])).toThrow('self-intersecting')
    expect(() => validatePaths([paths[0], { ...paths[1], points: paths[0].points.map(p => ({ x: p.x + 40, y: p.y + 10 })) }])).toThrow('cross or touch')
  })
  it('rejects partially overlapping score segments', () => {
    const path = { id: 'a', layer: 'Score', operation: 'score' as const, closed: false, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }
    expect(() => validatePaths([path, { ...path, id: 'b', points: [{ x: 5, y: 0 }, { x: 15, y: 0 }] }])).toThrow('Overlapping')
  })
  it('rejects collapsed holes, out-of-bed stock and invalid numerical settings', () => {
    const input = fixture(); input.material.kerf = 2
    input.lines[0].design.paths[1].points = [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 6, y: 6 }, { x: 5, y: 6 }]
    expect(() => planJob(input)).toThrow('collapses')
    const tooBig = fixture(); tooBig.material.sheetWidth = 1000
    expect(() => planJob(tooBig)).toThrow('bed')
    const bad = fixture(); bad.material.cut.speedMmS = NaN
    expect(() => planJob(bad)).toThrow()
    const overPower = fixture(); overPower.material.cut.maxPower = 80
    expect(() => planJob(overPower)).toThrow('power limit')
  })
  it('respects grain, fits exact bounds and creates more sheets as needed', () => {
    const input = fixture(); input.material.sheetWidth = 35; input.material.sheetHeight = 65; input.material.margin = 1
    const rotated = planJob(input)
    expect(rotated.sheets).toHaveLength(3)
    expect(rotated.sheets.every(s => s.placements[0].rotated)).toBe(true)
    input.material.grainLocked = true
    expect(() => planJob(input)).toThrow('does not fit')
    input.material.grainLocked = false; input.material.sheetWidth = 62.15; input.material.sheetHeight = 32.15
    expect(planJob(input).sheets).toHaveLength(3)
  })
  it('never overlaps packed bounding rectangles including configured spacing', () => {
    const input = fixture(); input.lines[0].quantity = 120
    const plan = planJob(input)
    for (const sheet of plan.sheets) for (let i = 0; i < sheet.placements.length; i++) for (let j = i + 1; j < sheet.placements.length; j++) {
      const a = sheet.placements[i], b = sheet.placements[j], gap = input.material.spacing - .001
      expect(a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x || a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y).toBe(true)
    }
  })
  it('quotes spreadsheet formula-like order identifiers', () => {
    const input = fixture(); input.lines[0].order = '=HYPERLINK("x")'
    expect(cuttingList(planJob(input))).toContain("\"'=HYPERLINK")
  })
})
describe('SVG and DXF import', () => {
  it('preserves physical dimensions and samples curves rather than stroke outlines', async () => {
    const d = await importDesign('<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 200 100"><rect width="200" height="100"/><circle cx="20" cy="20" r="5"/><path d="M40 50 C60 0 80 100 100 50"/></svg>', 'part.svg')
    expect(bounds(d.paths[0].points).width).toBe(100)
    expect(bounds(d.paths[1].points).width).toBeCloseTo(5, 2)
    expect(d.paths[2].operation).toBe('score')
    expect(d.approved).toBe(false)
    expect(d.sourceHash).toHaveLength(64)
    validatePaths(d.paths)
  })
  it('rejects missing units, external references, effects and text', async () => {
    for (const source of ['<svg width="100" height="50"><rect width="10" height="10"/></svg>', '<svg width="10mm" height="10mm"><text>Hi</text></svg>', '<svg width="10mm" height="10mm"><use href="https://example.com/x"/></svg>', '<svg width="10mm" height="10mm"><g style="display:none"><rect width="1" height="1"/></g></svg>']) await expect(importDesign(source, 'bad.svg')).rejects.toThrow()
  })
  it('requires DXF units and preserves a tiny hole without router substitutions', async () => {
    const dxf = '0\nSECTION\n2\nENTITIES\n0\nCIRCLE\n8\nHOLES\n10\n0\n20\n0\n40\n0.05\n0\nENDSEC\n0\nEOF\n'
    await expect(importDesign(dxf, 'hole.dxf')).rejects.toThrow('units')
    const d = await importDesign(dxf, 'hole.dxf', 'inches')
    expect(bounds(d.paths[0].points).width).toBeCloseTo(2.54, 1)
    expect(d.paths[0].operation).toBe('cut')
  })
})
it('Ruida byte transformation is reversible for all 256 bytes', () => {
  for (let i = 0; i < 256; i++) expect(unscramble(scramble(i))).toBe(i)
  expect(scramble(0xcc)).toBe(0xc6)
})
