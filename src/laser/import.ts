import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js'
import type { Curve, Vector2 } from 'three'
import { readDxf } from '../cam/dxf'
import { bounds, clean, distance } from './geometry'
import { designSchema, sha256, type Design, type Point, type VectorPath } from './model'

function physicalLength(value: string | null): number {
  const match = value?.trim().match(/^([\d.]+)\s*(mm|cm|in|px)$/)
  if (!match || !(Number(match[1]) > 0)) throw new Error('SVG width and height must have explicit mm, cm, in or px units')
  return Number(match[1]) * ({ mm: 1, cm: 10, in: 25.4, px: 25.4 / 96 }[match[2]]!)
}
function svgPaths(source: string): VectorPath[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('SVG document types and entities are unsupported')
  const xml = new DOMParser().parseFromString(source, 'image/svg+xml')
  if (xml.querySelector('parsererror') || xml.documentElement.localName !== 'svg') throw new Error('Invalid SVG document')
  const root = xml.documentElement
  const allowed = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'title', 'desc', 'metadata'])
  for (const node of Array.from(root.querySelectorAll('*'))) {
    if (node.closest('metadata')) continue
    if (!allowed.has(node.localName) || node.localName === 'svg') throw new Error(`Unsupported SVG element <${node.localName}>. Convert text to paths and remove images, definitions and effects.`)
  }
  for (const node of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (node.closest('metadata')) continue
    for (const attr of Array.from(node.attributes)) {
      if (/^on|href$|^(display|visibility|opacity|clip-path|mask|filter)$/i.test(attr.name) || /url\s*\(|!important|display\s*:|visibility\s*:|opacity\s*:|clip|filter|mask/i.test(attr.value) && attr.name === 'style') throw new Error('SVG contains hidden content, references or effects. Flatten these before importing.')
      if (['x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'x2', 'y1', 'y2', 'width', 'height'].includes(attr.name) && node !== root && /[a-z%]/i.test(attr.value.replace(/e[+-]?\d+/gi, ''))) throw new Error('SVG geometry must use numeric drawing coordinates; only root dimensions may contain units')
    }
  }
  const width = physicalLength(root.getAttribute('width')), height = physicalLength(root.getAttribute('height'))
  const vb = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number) ?? [0, 0, width * 96 / 25.4, height * 96 / 25.4]
  if (vb.length !== 4 || !vb.every(Number.isFinite) || vb[2] <= 0 || vb[3] <= 0) throw new Error('Invalid SVG viewBox')
  const aspect = root.getAttribute('preserveAspectRatio')?.trim() ?? 'xMidYMid meet'
  if (!['none', 'xMidYMid', 'xMidYMid meet'].includes(aspect)) throw new Error('Unsupported SVG preserveAspectRatio; use xMidYMid meet or none')
  let sx = width / vb[2], sy = height / vb[3]
  if (aspect !== 'none') sx = sy = Math.min(sx, sy)
  const ox = aspect === 'none' ? 0 : (width - vb[2] * sx) / 2, oy = aspect === 'none' ? 0 : (height - vb[3] * sy) / 2
  const transform = (p: Vector2): Point => ({ x: (p.x - vb[0]) * sx + ox, y: (p.y - vb[1]) * sy + oy })
  let total = 0
  const sample = (curve: Curve<Vector2>): Point[] => {
    const output: Point[] = [transform(curve.getPoint(0))]
    const split = (a: number, b: number, pa: Point, pb: Point, depth: number) => {
      const probes = [0.25, 0.5, 0.75].map(t => ({ t, p: transform(curve.getPoint(a + (b - a) * t)) }))
      const error = Math.max(...probes.map(({ t, p }) => distance(p, { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t })))
      if (error > 0.01) {
        if (depth >= 18) throw new Error('SVG curve is too complex')
        split(a, (a + b) / 2, pa, probes[1].p, depth + 1); split((a + b) / 2, b, probes[1].p, pb, depth + 1)
      } else { output.push(pb); if (++total > 12000) throw new Error('SVG exceeds 12,000 vertices; simplify it') }
    }
    split(0, 1, output[0], transform(curve.getPoint(1)), 0)
    return output
  }
  const loader = new SVGLoader(); loader.defaultDPI = 96
  const result: VectorPath[] = []
  for (const shape of loader.parse(source).paths) {
    const node = shape.userData?.node as Element | undefined
    const layer = node?.getAttribute('data-layer') || node?.parentElement?.getAttribute('id') || node?.getAttribute('id') || 'Drawing'
    for (const sub of shape.subPaths) {
      if (!sub.curves.length) continue
      const points = sub.curves.flatMap((c, i) => sample(c).slice(i ? 1 : 0))
      const closed = sub.autoClose || distance(points[0], points.at(-1)!) < 0.001
      result.push({ id: `path-${result.length + 1}`, layer, closed, operation: closed ? 'cut' : 'score', points: clean(points, closed) })
    }
  }
  return result
}
export async function importDesign(source: string, filename: string, units: 'auto' | 'mm' | 'inches' = 'auto'): Promise<Design> {
  if (source.length > 2_000_000) throw new Error('Drawing exceeds 2 MB')
  let paths: VectorPath[]
  if (/\.svg$/i.test(filename)) paths = svgPaths(source)
  else if (/\.dxf$/i.test(filename)) {
    const drawing = readDxf(source, units, 'mm')
    if (drawing.errors.length) throw new Error(drawing.errors.join('; '))
    if (drawing.warnings.some(w => w.includes('annotations are excluded'))) throw new Error('DXF contains text or dimensions. Convert intended markings to paths and remove annotation entities.')
    if (units === 'auto' && drawing.units === 'unknown') throw new Error('DXF units are unspecified; choose millimetres or inches and import again')
    const factor = (units === 'auto' ? drawing.units : units) === 'inches' ? 25.4 : 1
    paths = drawing.features.map((f, i) => ({ id: `path-${i + 1}`, layer: f.layer || 'Drawing', operation: f.closed ? 'cut' : 'score', closed: f.closed, points: clean(f.points.map(p => ({ x: p.x * factor, y: -p.y * factor })), f.closed) }))
  } else throw new Error('Import an SVG or DXF vector drawing')
  if (!paths.length) throw new Error('Drawing contains no supported vectors')
  const box = bounds(paths.flatMap(p => p.points))
  for (const p of paths) p.points = p.points.map(v => ({ x: v.x - box.minX, y: v.y - box.minY }))
  return designSchema.parse({ id: crypto.randomUUID(), revision: 1, name: filename, sku: filename.replace(/\.[^.]+$/, ''), approved: false, sourceName: filename, sourceHash: await sha256(source), allowRotation: true, paths })
}
