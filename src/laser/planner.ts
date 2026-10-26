import { MaxRectsPacker, Rectangle } from 'maxrects-packer'
import { bounds, distance, inside, offset, validatePaths } from './geometry'
import { requestSchema, type JobRequest, type Plan, type PlannedPath, type Point } from './model'

export function planJob(input: JobRequest): Plan {
  const request = requestSchema.parse(input), { machine, material, lines } = request
  if (material.machineId !== machine.id || material.machineRevision !== machine.revision) throw new Error('Material profile does not match this machine revision')
  if (!material.approved || lines.some(l => !l.design.approved)) throw new Error('Approve every design and the material profile before preparing a job')
  if (material.sheetWidth > machine.bedWidth || material.sheetHeight > machine.bedHeight) throw new Error('Stock sheet exceeds machine bed')
  if (material.margin * 2 >= Math.min(material.sheetWidth, material.sheetHeight)) throw new Error('Margins leave no usable sheet')
  if ([material.cut, material.score].some(s => s.maxPower > machine.maxPower)) throw new Error('Material settings exceed the machine power limit')
  const revisions = new Map<string, string>()
  for (const line of lines) {
    if (line.design.materialId && line.design.materialId !== material.id) throw new Error(`SKU ${line.design.sku} requires a different material profile`)
    const key = `${line.design.id}:${line.design.revision}`, json = JSON.stringify(line.design)
    if (revisions.has(key) && revisions.get(key) !== json) throw new Error('One design revision has conflicting definitions')
    revisions.set(key, json)
  }
  const prepared = lines.map((line, lineIndex) => {
    const paths = validatePaths(line.design.paths)
    const cuts = paths.filter(p => p.operation === 'cut')
    const compensated = paths.map(p => {
      const depth = p.operation === 'cut' ? cuts.filter(other => other.id !== p.id && inside(p.points[0], other.points)).length : 0
      return { ...p, depth, points: p.operation === 'cut' ? offset(p.points, (depth % 2 ? -1 : 1) * material.kerf / 2) : p.points }
    })
    validatePaths(compensated)
    const box = bounds(compensated.flatMap(p => p.points))
    return { line, lineIndex, paths: compensated, box }
  })
  const packer = new MaxRectsPacker<Rectangle>(material.sheetWidth - material.margin * 2, material.sheetHeight - material.margin * 2, material.spacing, { smart: false, pot: false, square: false, allowRotation: false })
  const rectangles = prepared.flatMap(part => Array.from({ length: part.line.quantity }, (_, copy) => {
    const r = new Rectangle(Math.max(Math.ceil((part.box.width - 1e-8) * 1000) / 1000, .001), Math.max(Math.ceil((part.box.height - 1e-8) * 1000) / 1000, .001), 0, 0, false, part.line.design.allowRotation && !material.grainLocked)
    // MaxRects checks unrotated bounds before considering per-rectangle rotation.
    // Pre-rotate only when this is the sole orientation that fits the empty bin.
    if (r.allowRotation && (r.width > packer.width || r.height > packer.height) && r.height <= packer.width && r.width <= packer.height) r.rot = true
    r.data = { part, id: `line-${part.lineIndex + 1}-part-${copy + 1}` }
    return r
  }))
  packer.addArray(rectangles)
  if (rectangles.some(r => r.oversized)) throw new Error('A component does not fit the usable stock sheet with its rotation restrictions')
  let vertices = 0
  const sheets = packer.bins.map((bin, sheetIndex) => {
    const paths: PlannedPath[] = []
    const placements = bin.rects.map(rect => {
      const { part, id } = rect.data as { part: typeof prepared[number]; id: string }
      const { box, line } = part, x = rect.x + material.margin, y = rect.y + material.margin
      const transform = (p: Point): Point => rect.rot ? { x: x + box.height - (p.y - box.minY), y: y + p.x - box.minX } : { x: x + p.x - box.minX, y: y + p.y - box.minY }
      for (const path of part.paths) {
        if (path.operation === 'ignore') continue
        const points = path.points.map(transform)
        vertices += points.length * material[path.operation].passes
        if (vertices > 250000) throw new Error('Expanded job exceeds 250,000 vertices; split the batch')
        if (points.some(p => p.x < material.margin - .001 || p.y < material.margin - .001 || p.x > material.sheetWidth - material.margin + .001 || p.y > material.sheetHeight - material.margin + .001)) throw new Error('Compensated geometry exceeds the usable sheet')
        paths.push({ id: `${id}-${path.id}`, instanceId: id, operation: path.operation, points, closed: path.closed, depth: path.depth, settings: { ...material[path.operation] } })
      }
      return { id, sku: line.design.sku, name: line.design.name, order: line.order, designId: line.design.id, revision: line.design.revision, x, y, width: rect.width, height: rect.height, rotated: rect.rot }
    })
    // Every score precedes release cuts; all descendants precede enclosing cuts.
    paths.sort((a, b) => (a.operation === 'score' ? 0 : 1) - (b.operation === 'score' ? 0 : 1) || b.depth - a.depth || a.id.localeCompare(b.id))
    let travelMm = 0, cutMm = 0, estimatedSeconds = 0, cursor = { x: 0, y: 0 }
    for (const path of paths) for (let pass = 0; pass < path.settings.passes; pass++) {
      travelMm += distance(cursor, path.points[0])
      let length = path.closed ? distance(path.points.at(-1)!, path.points[0]) : 0
      for (let i = 1; i < path.points.length; i++) length += distance(path.points[i - 1], path.points[i])
      cutMm += length; estimatedSeconds += length / path.settings.speedMmS
      cursor = path.closed ? path.points[0] : path.points.at(-1)!
    }
    return { number: sheetIndex + 1, width: material.sheetWidth, height: material.sheetHeight, placements, paths, travelMm, cutMm, estimatedSeconds }
  })
  return { schema: 'laser-plan/v1', plannerVersion: '1.0.0', request, sheets, warnings: ['Rectangular nesting; parts are not nested inside holes.', 'Time is beam-on travel only; acceleration, positioning and handling add time.', ...(machine.controller === 'ruida-rd' ? ['Experimental Ruida RD export. Controller model, origin and settings require commissioning. Live transfer is disabled.'] : ['Simulation: staging and run records do not operate a laser.'])] }
}
