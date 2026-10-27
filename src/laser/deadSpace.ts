import { MaxRectsBin, Rectangle } from 'maxrects-packer'
import type { DeadSpace, JobRequest, Material, Plan, Sheet, SheetDeadSpaces } from './model'

export function withSheetDeadSpaces(request: JobRequest, sheetNumber: number, zones: DeadSpace[]): JobRequest {
  const sheets = (request.sheetDeadSpaces ?? []).filter(s => s.sheetNumber !== sheetNumber)
  if (zones.length) sheets.push({ sheetNumber, zones })
  return { ...request, sheetDeadSpaces: sheets.sort((a, b) => a.sheetNumber - b.sheetNumber) }
}

// Keep empty, marked physical sheets visible in the editor, without generating empty controller jobs.
export function layoutSheets(plan: Plan): Sheet[] {
  const sheets = [...plan.sheets]
  for (const marked of plan.request.sheetDeadSpaces ?? []) if (!sheets.some(s => s.number === marked.sheetNumber)) {
    sheets.push({ number: marked.sheetNumber, width: plan.request.material.sheetWidth, height: plan.request.material.sheetHeight,
      deadSpaces: marked.zones, placements: [], paths: [], travelMm: 0, cutMm: 0, estimatedSeconds: 0 })
  }
  return sheets.sort((a, b) => a.number - b.number)
}

export function separated(a: { x: number; y: number; width: number; height: number }, b: DeadSpace, spacing: number): boolean {
  const gap = spacing - 1e-7
  return a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x || a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y
}

function reserve(bin: MaxRectsBin<Rectangle>, zone: DeadSpace, material: Material) {
  // MaxRects reserves each part's spacing on its right/bottom. Give obstacles the same
  // padding so the required gap is symmetric in physical sheet coordinates.
  const used = new Rectangle(zone.width + material.spacing, zone.height + material.spacing, zone.x - material.margin, zone.y - material.margin)
  const free = bin.freeRects.flatMap(r => {
    if (!r.collide(used)) return [r]
    const pieces: Rectangle[] = []
    if (used.x > r.x) pieces.push(new Rectangle(used.x - r.x, r.height, r.x, r.y))
    if (used.x + used.width < r.x + r.width) pieces.push(new Rectangle(r.x + r.width - used.x - used.width, r.height, used.x + used.width, r.y))
    if (used.y > r.y) pieces.push(new Rectangle(r.width, used.y - r.y, r.x, r.y))
    if (used.y + used.height < r.y + r.height) pieces.push(new Rectangle(r.width, r.y + r.height - used.y - used.height, r.x, used.y + used.height))
    return pieces
  })
  bin.freeRects = free.filter((r, i) => !free.some((other, j) => j !== i && other.contain(r) && (!r.contain(other) || j < i)))
}

export function nestRectangles(rectangles: Rectangle[], material: Material, deadSpaces: SheetDeadSpaces = []) {
  const width = material.sheetWidth - material.margin * 2, height = material.sheetHeight - material.margin * 2
  const bins: { number: number; bin: MaxRectsBin<Rectangle>; zones: DeadSpace[] }[] = []
  for (const rect of [...rectangles].sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height))) {
    if ((rect.width > width || rect.height > height) && !(rect.allowRotation && rect.height <= width && rect.width <= height)) throw new Error('A component does not fit the usable stock sheet with its rotation restrictions')
    let placed = bins.some(b => b.bin.add(rect) !== undefined)
    while (!placed) {
      const number = bins.length + 1, zones = deadSpaces.find(s => s.sheetNumber === number)?.zones ?? []
      const bin = new MaxRectsBin<Rectangle>(width, height, material.spacing, { smart: false, pot: false, square: false, allowRotation: false })
      for (const zone of zones) reserve(bin, zone, material)
      bins.push({ number, bin, zones }); placed = bin.add(rect) !== undefined
      if (!placed && !zones.length) throw new Error('A component does not fit the usable stock sheet with its rotation restrictions')
    }
  }
  return bins.filter(b => b.bin.rects.length)
}
