import { xmlEscape } from './artifacts'
import { bounds, validatePaths } from './geometry'
import type { Point, VectorPath } from './model'

export const calibrationVersion = 'laser-calibration/v1'
export const calibrationMaterials = [
  { id: 'plywood-3mm', name: 'Plywood · 3 mm', code: 'P3', thickness: 3 },
  { id: 'plywood-6mm', name: 'Plywood · 6 mm', code: 'P6', thickness: 6 },
  { id: 'mdf-3mm', name: 'MDF · 3 mm', code: 'M3', thickness: 3 },
  { id: 'mdf-6mm', name: 'MDF · 6 mm', code: 'M6', thickness: 6 },
] as const
export type CalibrationMaterial = typeof calibrationMaterials[number]
export interface CalibrationTest {
  id: string; title: string; width: number; height: number; paths: VectorPath[]
  instructions: string; measurements: string[]
  cells?: { id: string; row: number; column: number }[]
  slotWidths?: number[]
}
const p = (x: number, y: number): Point => ({ x, y })
const round = (n: number) => Number(n.toFixed(4))
const path = (id: string, points: Point[], closed = true, operation: 'cut' | 'score' = 'cut'): VectorPath => ({ id, layer: `${operation.toUpperCase()}_${id}`, points, closed, operation })
const rect = (id: string, x: number, y: number, w: number, h: number) => path(id, [p(x, y), p(x + w, y), p(x + w, y + h), p(x, y + h)])
const circle = (id: string, x: number, y: number, r: number) => path(id, Array.from({ length: 96 }, (_, i) => p(round(x + r * Math.cos(i * Math.PI / 48)), round(y + r * Math.sin(i * Math.PI / 48)))))

// Original single-line glyphs. Each stroke is open so SVG/DXF import treats labels as scores.
const glyphs: Record<string, number[][]> = {
  '0': [[0, 0, 2, 0, 2, 3.9], [2, 4, 0, 4, 0, .1]],
  '1': [[.4, 1, 1, 0, 1, 4], [.3, 4, 1.7, 4]],
  '2': [[0, 0, 2, 0, 2, 2, 0, 2, 0, 4, 2, 4]],
  '3': [[0, 0, 2, 0, 2, 4, 0, 4], [0, 2, 2, 2]],
  '4': [[0, 0, 0, 2, 2, 2], [2, 0, 2, 4]],
  '5': [[2, 0, 0, 0, 0, 2, 2, 2, 2, 4, 0, 4]],
  '6': [[2, 0, 0, 0, 0, 4, 2, 4, 2, 2, .1, 2]],
  '7': [[0, 0, 2, 0, .5, 4]],
  '8': [[0, 1.9, 0, 0, 2, 0, 2, 4, 0, 4, 0, 2.1], [0, 2, 2, 2]],
  '9': [[2, 4, 2, 0, 0, 0, 0, 2, 1.9, 2]],
  A: [[0, 4, 0, 1, 1, 0, 2, 1, 2, 4], [0, 2, 2, 2]],
  B: [[0, 4, 0, 0, 1.5, 0, 2, .5, 2, 1.5, 1.5, 2, .1, 2], [1.5, 2, 2, 2.5, 2, 3.5, 1.5, 4, .1, 4]],
  C: [[2, 0, 0, 0, 0, 4, 2, 4]],
  K: [[0, 0, 0, 4], [2, 0, 0, 2, 2, 4]],
  M: [[0, 4, 0, 0, 1, 2, 2, 0, 2, 4]],
  P: [[0, 4, 0, 0, 2, 0, 2, 2, .1, 2]],
  V: [[0, 0, 1, 4, 2, 0]],
  X: [[0, 0, 2, 4], [0, 4, 2, 0]],
  Y: [[0, 0, 1, 2, 2, 0], [1, 2, 1, 4]],
}
function label(text: string, x: number, y: number, prefix: string): VectorPath[] {
  return [...text].flatMap((char, i) => {
    if (!glyphs[char]) throw new Error(`Unsupported calibration label ${char}`)
    return glyphs[char].map((stroke, j) => path(`${prefix}-${i}-${j}`, Array.from({ length: stroke.length / 2 }, (_, k) => p(x + i * 3.5 + stroke[k * 2], y + stroke[k * 2 + 1])), false, 'score'))
  })
}
function coupon(id: string, x: number, y: number): VectorPath[] {
  // 20 × 20 mm outline with one radius-4 corner, plus a 6 mm circular cutout.
  const arc = Array.from({ length: 17 }, (_, i) => p(round(x + 16 + 4 * Math.cos(-Math.PI / 2 + i * Math.PI / 32)), round(y + 4 + 4 * Math.sin(-Math.PI / 2 + i * Math.PI / 32))))
  return [circle(`${id}-hole`, x + 10, y + 10, 3), path(`${id}-outline`, [p(x, y), ...arc, p(x + 20, y + 20), p(x, y + 20)])]
}
export function calibrationTests(material: CalibrationMaterial, measuredThickness = material.thickness as number): CalibrationTest[] {
  if (!Number.isFinite(measuredThickness) || measuredThickness <= .5 || measuredThickness > 8) throw new Error('Measured stock thickness must be above 0.5 and at most 8 mm')
  const code = (x = 5, y = 3) => label(material.code, x, y, 'material')
  const orientation: CalibrationTest = {
    id: '01-orientation', title: 'Orientation and scale marks', width: 130, height: 80,
    instructions: 'Score only, using a reviewed marking setting. Keep at 100% scale. X points right and Y points down in this top-view drawing. Check orientation with the manufacturer’s frame/preview procedure before firing. No focus or axis commands are included.',
    measurements: ['Horizontal centre-line span: 100 mm', 'Vertical centre-line span: 50 mm', 'Confirm P3/P6/M3/M6 reads normally, X right and Y down'],
    paths: [...code(), path('axes', [p(10, 65), p(10, 15), p(110, 15)], false, 'score'), path('arrow-x', [p(106, 12), p(110, 15), p(106, 18)], false, 'score'), path('arrow-y', [p(7, 61), p(10, 65), p(13, 61)], false, 'score'), ...label('X', 114, 13, 'x'), ...label('Y', 8, 69, 'y')],
  }
  const pilot: CalibrationTest = { id: '02-pilot', title: 'Single pilot coupon', width: 40, height: 45, paths: [...code(), ...label('P1', 17, 10, 'id'), ...label('P1', 17, 33, 'part-id'), ...coupon('P1', 10, 18)], instructions: 'Establish a clean cut on one coupon using the machine supplier’s starting range before running a grid. Inner hole before outer cut; label first with a separate marking setting. Record speed in mm/s, minimum/maximum power, passes, focus and air assist.', measurements: ['20 × 20 mm outer path', '6 mm circular cutout', 'Cut-through, edge char, corner overburn and underside marking'] }
  const cells = Array.from({ length: 9 }, (_, i) => ({ id: `${'ABC'[Math.floor(i / 3)]}${i % 3 + 1}`, row: Math.floor(i / 3), column: i % 3 }))
  const matrix: CalibrationTest = { id: '03-cut-matrix', title: 'Nine speed / power trials', width: 110, height: 115, cells, paths: [...code(), ...cells.flatMap(c => [...label(c.id, 17 + c.column * 32, 10 + c.row * 32, `label-${c.id}`), ...label(c.id, 17 + c.column * 32, 33 + c.row * 32, `part-${c.id}`), ...coupon(c.id, 10 + c.column * 32, 18 + c.row * 32)])], instructions: 'Columns 1 → 3: fast → slow. Rows A → C: low → high power. Actual values are deliberately unset until the machine and supplier limits are known. Use separate cell files for initial trials; keep passes, focus and air assist fixed. A geometry import does not apply different settings to the cells automatically.', measurements: ['Record settings and result for every cell', 'Clean separation without forcing the part', 'Char and corner quality on front, back and edge'] }
  const kerf: CalibrationTest = { id: '04-kerf', title: 'Three plug / hole pairs', width: 100, height: 45, paths: [...code(), ...[0, 1, 2].flatMap(i => [...label(`K${i + 1}`, 17 + i * 30, 9, `label-k${i}`), ...label(`K${i + 1}`, 17 + i * 30, 22, `plug-k${i}`), rect(`K${i + 1}`, 10 + i * 30, 16, 20, 20)])], instructions: 'Use the winning cut setting with ZERO kerf compensation and no resize. Keep each plug with its own hole. Measure the straight edges of plug and hole in X and Y on the same face, away from corners; do not sand them. Repeat on the back to investigate taper.', measurements: ['Plug X, hole X, plug Y, hole Y for K1–K3', 'Kerf per axis = (hole − plug) / 2', 'Centre-line dimension per axis = (hole + plug) / 2; expected 20 mm'] }
  const slotWidths = Array.from({ length: 8 }, (_, i) => round(measuredThickness - .5 + i * .1))
  const comb: Point[] = [p(10, 20)]
  slotWidths.forEach((width, i) => { const x = 18 + i * 13; comb.push(p(x, 20), p(x, 30), p(x + width, 30), p(x + width, 20)) })
  comb.push(p(130, 20), p(130, 48), p(10, 48))
  const fit: CalibrationTest = { id: '05-fit-comb', title: 'Eight-slot fit comb', width: 170, height: 60, slotWidths, paths: [...code(), ...slotWidths.flatMap((_, i) => label(String(i + 1), 19 + i * 13, 36, `slot-${i}`)), ...label(material.code, 116, 41, 'comb-material'), ...label(material.code, 145, 35, 'strip-material'), path('comb', comb), rect('mating-strip', 140, 20, 20, 28)], instructions: `Slots 1–8 use drawn widths ${slotWidths.join(', ')} mm, based on ${measuredThickness} mm stock. Cut uncompensated. Insert the mating strip edge-on, so its uncut broad faces set the tab thickness. Record snug/sliding/loose without forcing. Regenerate around actual measured thickness if all slots fit badly. Fit allowance is separate from kerf compensation.`, measurements: ['Actual material thickness at three points', 'Chosen slot number and fit', 'Drawn slot width + measured kerf − measured thickness estimates clearance'] }
  const validation: CalibrationTest = { id: '06-validation', title: 'Final dimension and hole check', width: 75, height: 60, paths: [...code(), ...label('V1', 31, 39, 'id'), circle('hole-round', 23, 28, 5), rect('hole-square', 41, 23, 10, 10), rect('outer', 10, 18, 50, 30)], instructions: 'Run AFTER selecting settings and measuring kerf. Apply the chosen compensation exactly once in the planner: outer contour outwards by half the kerf and holes inwards by half. The supplied geometry is nominal and contains no built-in offset. This is a fresh validation cut, not another raw kerf measurement.', measurements: ['Outer part: 50 × 30 mm', 'Round hole: 10 mm diameter', 'Square hole: 10 × 10 mm', 'Compare X and Y, front/back and fit before approving a production profile'] }
  const separateCells: CalibrationTest[] = cells.map(c => ({ ...pilot, id: `03-cell-${c.id}`, title: `Individual matrix trial ${c.id}`, cells: [c], paths: [...code(), ...label(c.id, 17, 10, `label-${c.id}`), ...label(c.id, 17, 33, `part-${c.id}`), ...coupon(c.id, 10, 18)], instructions: `Run only matrix cell ${c.id}, using its recorded settings on fresh stock. This duplicates that cell in the grid; do not count both as separate results unless marked as repeats.` }))
  return [orientation, pilot, matrix, kerf, fit, validation, ...separateCells].map(test => {
    validatePaths(test.paths)
    const box = bounds(test.paths.flatMap(v => v.points))
    if (box.minX < 0 || box.minY < 0 || box.maxX > test.width || box.maxY > test.height) throw new Error(`${test.id} exceeds its stock rectangle`)
    return test
  })
}

export function calibrationSvg(test: CalibrationTest): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${test.width}mm" height="${test.height}mm" viewBox="0 0 ${test.width} ${test.height}">\n<title>${xmlEscape(test.title)}</title><desc>Geometry only. Millimetres. No power or speed settings. Red = cut; blue = score. No background, border or live text.</desc>\n${test.paths.map(v => `<path id="${v.id}" data-layer="${v.layer}" data-operation="${v.operation}" d="M${v.points.map(pt => `${round(pt.x)},${round(pt.y)}`).join('L')}${v.closed ? 'Z' : ''}" fill="none" stroke="${v.operation === 'cut' ? '#ff0000' : '#0000ff'}" stroke-width="0.05"/>`).join('\n')}\n</svg>\n`
}
export function calibrationDxf(test: CalibrationTest): string {
  const pairs: (string | number)[] = [0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1015', 9, '$INSUNITS', 70, 4, 9, '$MEASUREMENT', 70, 1, 0, 'ENDSEC', 0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, test.paths.length]
  for (const v of test.paths) pairs.push(0, 'LAYER', 2, v.layer, 70, 0, 62, v.operation === 'cut' ? 1 : 5, 6, 'CONTINUOUS')
  pairs.push(0, 'ENDTAB', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES')
  for (const v of test.paths) {
    pairs.push(0, 'LWPOLYLINE', 100, 'AcDbEntity', 8, v.layer, 62, v.operation === 'cut' ? 1 : 5, 100, 'AcDbPolyline', 90, v.points.length, 70, v.closed ? 1 : 0)
    // DXF is Y-up; SVG/reference drawings are Y-down. Preserve the same top-view orientation.
    for (const pt of v.points) pairs.push(10, round(pt.x), 20, round(test.height - pt.y))
  }
  pairs.push(0, 'ENDSEC', 0, 'EOF')
  return pairs.join('\n') + '\n'
}
export interface KerfMeasurement { plugX: number; holeX: number; plugY: number; holeY: number }
export function analyseKerf(samples: KerfMeasurement[]) {
  if (samples.length < 3) throw new Error('Enter measurements for all three plug/hole pairs')
  const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const i = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2 }
  for (const sample of samples) for (const axis of ['X', 'Y'] as const) {
    const plug = sample[`plug${axis}`], hole = sample[`hole${axis}`]
    if (![plug, hole].every(v => Number.isFinite(v) && v > 18 && v < 22) || hole <= plug) throw new Error('Use positive calliper readings around 20 mm; each hole must be larger than its matching plug')
  }
  const xs = samples.map(s => (s.holeX - s.plugX) / 2), ys = samples.map(s => (s.holeY - s.plugY) / 2)
  const x = median(xs), y = median(ys), centreX = median(samples.map(s => (s.holeX + s.plugX) / 2)), centreY = median(samples.map(s => (s.holeY + s.plugY) / 2))
  const warnings: string[] = []
  if (Math.abs(x - y) > .05 + 1e-8) warnings.push('X/Y kerf differs by more than 0.05 mm. Check focus, alignment, grain and measurement before using one kerf value.')
  if (Math.max(...xs) - Math.min(...xs) > .05 + 1e-8 || Math.max(...ys) - Math.min(...ys) > .05 + 1e-8) warnings.push('Repeated kerf readings vary by more than 0.05 mm. Repeat with consistent material and focus.')
  if (Math.abs(centreX - 20) > .1 + 1e-8 || Math.abs(centreY - 20) > .1 + 1e-8) warnings.push('Centre-line size differs from 20 mm by more than 0.1 mm. Check import scale and measure the longer axis marks; do not hide a scale error in kerf.')
  return { kerfMm: round(median([...xs, ...ys])), kerfX: round(x), kerfY: round(y), centreX: round(centreX), centreY: round(centreY), warnings }
}
