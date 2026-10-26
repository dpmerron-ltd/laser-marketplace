import { beforeAll, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { analyseKerf, calibrationDxf, calibrationMaterials, calibrationSvg, calibrationTests } from './calibration'
import { importDesign } from './import'
import { bounds, validatePaths } from './geometry'
import { defaultMachine, defaultMaterial, demoDesign } from './model'
import { planJob } from './planner'
beforeAll(() => { vi.stubGlobal('crypto', webcrypto) })

describe('calibration drawings', () => {
  it('creates valid, bounded, labelled geometry for all four materials without machine settings', () => {
    for (const material of calibrationMaterials) {
      const tests = calibrationTests(material)
      expect(tests).toHaveLength(15)
      expect(new Set(tests.map(t => t.id)).size).toBe(15)
      expect(tests.find(t => t.id === '03-cut-matrix')!.cells!.map(c => c.id)).toEqual(['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3'])
      for (const test of tests) {
        validatePaths(test.paths)
        expect(test.paths.length).toBeLessThanOrEqual(250)
        expect(test.paths.every(p => p.operation === 'cut' ? p.closed : !p.closed)).toBe(true)
        expect(test.paths.some(p => p.id.startsWith('material-'))).toBe(true)
        const box = bounds(test.paths.flatMap(p => p.points))
        expect(box.minX).toBeGreaterThanOrEqual(0); expect(box.minY).toBeGreaterThanOrEqual(0)
        expect(box.maxX).toBeLessThanOrEqual(test.width); expect(box.maxY).toBeLessThanOrEqual(test.height)
        expect(calibrationSvg(test)).not.toMatch(/<text|<rect|<image|power=|speed=/)
      }
    }
  })
  it('roundtrips every SVG and DXF through the actual importer with correct units, orientation and operations', async () => {
    for (const test of calibrationTests(calibrationMaterials[0])) {
      const box = bounds(test.paths.flatMap(p => p.points))
      for (const extension of ['svg', 'dxf']) {
        const imported = await importDesign(extension === 'svg' ? calibrationSvg(test) : calibrationDxf(test), `${test.id}.${extension}`)
        expect(imported.paths).toHaveLength(test.paths.length)
        for (const source of test.paths) {
          // The shared DXF reader returns closed contours before open score chains.
          const target = imported.paths.find(p => p.layer === source.layer)!
          expect(target.operation, `${test.id} ${extension} ${source.id}`).toBe(source.operation)
          expect(target.closed).toBe(source.closed)
          const actual = bounds(target.points), original = bounds(source.points)
          expect(actual.minX).toBeCloseTo(original.minX - box.minX, 3)
          expect(actual.minY).toBeCloseTo(original.minY - box.minY, 3)
          expect(actual.width).toBeCloseTo(original.width, 3); expect(actual.height).toBeCloseTo(original.height, 3)
        }
        validatePaths(imported.paths)
      }
    }
  })
  it('keeps kerf coupons exactly 20 mm and offsets the validation outside and holes once', () => {
    const tests = calibrationTests(calibrationMaterials[0]), kerf = tests.find(t => t.id === '04-kerf')!, validation = tests.find(t => t.id === '06-validation')!
    for (const path of kerf.paths.filter(p => p.operation === 'cut')) { expect(bounds(path.points).width).toBe(20); expect(bounds(path.points).height).toBe(20) }
    const plan = planJob({ reference: 'CAL-VALIDATION', machine: defaultMachine, material: { ...defaultMaterial, approved: true, kerf: .2 }, lines: [{ design: { ...demoDesign, approved: true, paths: validation.paths, allowRotation: false }, quantity: 1, order: 'CAL' }] })
    const outer = plan.sheets[0].paths.find(p => p.id.endsWith('-outer'))!, hole = plan.sheets[0].paths.find(p => p.id.endsWith('-hole-square'))!
    expect(bounds(outer.points).width).toBeCloseTo(50.2, 4); expect(bounds(outer.points).height).toBeCloseTo(30.2, 4)
    expect(bounds(hole.points).width).toBeCloseTo(9.8, 4)
    expect(plan.sheets[0].paths.indexOf(hole)).toBeLessThan(plan.sheets[0].paths.indexOf(outer))
  })
  it('draws open-ended slots as one contour and regenerates widths around measured stock', () => {
    const fit = calibrationTests(calibrationMaterials[0], 2.83).find(t => t.id === '05-fit-comb')!
    expect(fit.slotWidths).toEqual([2.33, 2.43, 2.53, 2.63, 2.73, 2.83, 2.93, 3.03])
    expect(fit.paths.filter(p => p.operation === 'cut')).toHaveLength(2)
    expect(() => calibrationTests(calibrationMaterials[0], NaN)).toThrow('thickness')
  })
})
describe('measured kerf', () => {
  const sample = { plugX: 19.8, holeX: 20.2, plugY: 19.8, holeY: 20.2 }
  it('calculates the full kerf, not the half-kerf toolpath offset', () => {
    const result = analyseKerf([sample, sample, { plugX: 19.78, holeX: 20.22, plugY: 19.8, holeY: 20.2 }])
    expect(result).toEqual({ kerfMm: .2, kerfX: .2, kerfY: .2, centreX: 20, centreY: 20, warnings: [] })
  })
  it('flags scale error, inconsistent measurements and different X/Y kerfs', () => {
    const result = analyseKerf([{ ...sample, holeY: 20.7, plugY: 20.1 }, { ...sample, holeY: 20.7, plugY: 20.1 }, { ...sample, holeX: 20.6, holeY: 20.7, plugY: 20.1 }])
    expect(result.warnings).toHaveLength(3)
  })
  it('rejects missing or physically inconsistent readings', () => {
    expect(() => analyseKerf([sample])).toThrow('three')
    for (const invalid of [{ ...sample, plugX: NaN }, { ...sample, plugX: 20.5 }, { ...sample, plugX: 0 }]) expect(() => analyseKerf([sample, sample, invalid])).toThrow('calliper')
  })
})
