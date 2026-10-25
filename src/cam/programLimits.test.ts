// @vitest-environment node
import { expect, it } from 'vitest'
import { generateDxfNc } from '../../api/dxf'
import { readDxf } from './dxf'
import { generateMaterialVariants } from './materialVariants'
import { materialVariantsSchema } from './materialProfiles'
import { maxApiProgramLines, maxCamProgramLines, maxNcBytes, ncSizeError } from './limits'
import { createPartFromGCode } from '../gcode/importPart'
import { selectMaterialParts } from '../gcode/materialSelection'
import { simulateGCode } from '../gcode/simulator'

const profile = '14-4pass-2mm-ramp10-5deg'
const dxf = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES',
  ...Array.from({ length: 40 }, (_, i) => [0, 'CIRCLE', 8, 'CUT_INNER', 10, 50 + i % 10 * 80, 20, 50 + Math.floor(i / 10) * 80, 40, 25]).flat(),
  0, 'ENDSEC', 0, 'EOF', ''].join('\n')

it('keeps a dense four-pass browser variant available with all passes and movements intact', () => {
  const variants = generateMaterialVariants(readDxf(dxf), { thickness: 14, profilePasses: 4, drillDepthMm: 2, rampProfile: '10mm-s-5deg', units: 'auto', operations: {} }, undefined, [profile])
  const variant = variants.profiles[profile]!
  expect(variant.errors).toEqual([])
  expect(variant.gcode.split('\n').length).toBeGreaterThan(maxApiProgramLines)
  expect(variant.gcode.split('\n').length).toBeLessThanOrEqual(maxCamProgramLines)
  expect(new TextEncoder().encode(variant.gcode).length).toBeLessThanOrEqual(maxNcBytes)
  expect(materialVariantsSchema.safeParse(variants).success).toBe(true)
  for (const depth of [3.6, 7.2, 10.8, 14.4]) expect(variant.gcode.split(`(Pass depth ${depth} mm)`)).toHaveLength(41)
  const part = createPartFromGCode('tool-board.nc', variant.gcode, dxf)
  part.metadata.materialVariants = variants
  const selected = selectMaterialParts([part], { materialProfile: profile, instances: [{ partId: part.id }] })
  expect(selected.errors).toEqual([])
  expect(selected.parts[0].gcode).toBe(variant.gcode)
  expect(simulateGCode(selected.parts[0].gcode)).toMatchObject({ errors: [], deepestCutMm: 14.4 })
}, 20000)

it('retains the API line limit for both primary and alternate variants', async () => {
  const result = await generateDxfNc({ dxf, thicknessMm: 6, variantProfiles: ['6', profile] })
  expect(result.gcode).not.toBe('')
  expect(result.materialVariants.profiles[profile]).toMatchObject({ gcode: '', errors: [expect.stringContaining('20,000 lines')] })
  await expect(generateDxfNc({ dxf, thicknessMm: 14, profilePasses: 4, drillDepthMm: 2, rampProfile: '10mm-s-5deg', variantProfiles: [profile] })).rejects.toMatchObject({ status: 422, message: expect.stringContaining('20,000 lines') })
}, 20000)

it('enforces the complete program line and UTF-8 byte boundaries', () => {
  expect(ncSizeError('\n'.repeat(maxCamProgramLines - 1), maxCamProgramLines)).toBeUndefined()
  expect(ncSizeError('\n'.repeat(maxCamProgramLines), maxCamProgramLines)).toContain('50,000 lines')
  expect(ncSizeError('é'.repeat(maxNcBytes / 2), maxCamProgramLines)).toBeUndefined()
  expect(ncSizeError('é'.repeat(maxNcBytes / 2) + 'x', maxCamProgramLines)).toContain('2 MB')
})
