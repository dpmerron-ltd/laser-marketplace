import ClipperLib from 'clipper-lib'
import type { Point, VectorPath } from './model'

const scale = 10000
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const poly = (p: Point[]) => p.map(v => ({ X: Math.round(v.x * scale), Y: Math.round(v.y * scale) }))
export const area = (p: Point[]) => ClipperLib.Clipper.Area(poly(p)) / scale ** 2
export const inside = (p: Point, polygon: Point[]) => ClipperLib.Clipper.PointInPolygon(poly([p])[0], poly(polygon)) === 1
export function bounds(points: Point[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}
export function clean(points: Point[], closed: boolean): Point[] {
  const result = points.filter((p, i) => !i || distance(p, points[i - 1]) > 0.0001)
  if (closed && result.length > 1 && distance(result[0], result.at(-1)!) < 0.0001) result.pop()
  return result
}
function cross(a: Point, b: Point, c: Point) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) }
function on(a: Point, b: Point, p: Point) { return Math.abs(cross(a, b, p)) < 1e-8 && p.x >= Math.min(a.x, b.x) - 1e-8 && p.x <= Math.max(a.x, b.x) + 1e-8 && p.y >= Math.min(a.y, b.y) - 1e-8 && p.y <= Math.max(a.y, b.y) + 1e-8 }
function intersects(a: Point, b: Point, c: Point, d: Point) {
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x) || Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) return false
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0 || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)
}
function segments(path: Pick<VectorPath, 'points' | 'closed'>) {
  return path.points.slice(0, path.closed ? undefined : -1).map((p, i) => [p, path.points[(i + 1) % path.points.length]] as const)
}
export function validatePaths(input: VectorPath[]) {
  const paths = input.filter(p => p.operation !== 'ignore').map(p => ({ ...p, points: clean(p.points, p.closed) }))
  if (!paths.length) throw new Error('Design has no cut or score paths')
  if (paths.reduce((n, p) => n + p.points.length, 0) > 12000) throw new Error('Design exceeds 12,000 vertices; simplify the drawing')
  const seen = new Set<string>()
  for (const p of paths) {
    if (p.points.length < (p.closed ? 3 : 2)) throw new Error(`${p.layer}: insufficient geometry`)
    if (p.operation === 'cut' && !p.closed) throw new Error(`${p.layer}: cut paths must be closed; use score for an intentional open path`)
    const segs = segments(p)
    for (const [i, [a, b]] of segs.entries()) {
      const ak = `${a.x.toFixed(4)},${a.y.toFixed(4)}`, bk = `${b.x.toFixed(4)},${b.y.toFixed(4)}`
      const key = [ak, bk].sort().join('|')
      if (seen.has(key)) throw new Error(`${p.layer}: duplicate or shared cutting/scoring segment`)
      seen.add(key)
      for (let j = i + 1; j < segs.length; j++) {
        const [c, d] = segs[j]
        const adjacent = j === i + 1 || p.closed && i === 0 && j === segs.length - 1
        if (!adjacent && intersects(a, b, c, d)) throw new Error(`${p.layer}: self-intersecting or touching path`)
        if (adjacent && Math.abs(cross(a, b, c)) < 1e-8 && Math.abs(cross(a, b, d)) < 1e-8) {
          // Consecutive collinear segments may continue, but must never double back.
          const next = j === i + 1 ? d : c
          const joint = j === i + 1 ? b : a
          const previous = j === i + 1 ? a : b
          if ((previous.x - joint.x) * (next.x - joint.x) + (previous.y - joint.y) * (next.y - joint.y) > 0) throw new Error(`${p.layer}: overlapping segments`)
        }
      }
    }
    if (p.closed && Math.abs(area(p.points)) < 0.0001) throw new Error(`${p.layer}: degenerate contour`)
  }
  // Also reject partial collinear overlaps (not just identical endpoint pairs).
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    if (paths[i].operation === 'cut' && paths[j].operation === 'cut') continue // handled below
    for (const [a, b] of segments(paths[i])) for (const [c, d] of segments(paths[j])) {
      if (Math.abs(cross(a, b, c)) > 1e-8 || Math.abs(cross(a, b, d)) > 1e-8) continue
      const axis = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 'x' : 'y'
      const overlap = Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) - Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis]))
      if (overlap > 0.0001) throw new Error('Overlapping cut or score segments would be processed twice')
    }
  }
  const cuts = paths.filter(p => p.operation === 'cut')
  for (let i = 0; i < cuts.length; i++) for (let j = i + 1; j < cuts.length; j++) {
    const a = bounds(cuts[i].points), b = bounds(cuts[j].points)
    if (a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY) continue
    for (const [p, q] of segments(cuts[i])) for (const [r, s] of segments(cuts[j])) if (intersects(p, q, r, s)) throw new Error('Cut contours cross or touch; separate or merge them before approval')
  }
  return paths
}
export function offset(points: Point[], delta: number) {
  if (Math.abs(delta) < 0.00001) return points
  const path = poly(points)
  if (!ClipperLib.Clipper.Orientation(path)) path.reverse()
  const offsetter = new ClipperLib.ClipperOffset(2, 0.01 * scale)
  offsetter.AddPath(path, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon)
  const result: ClipperLib.Paths = []
  offsetter.Execute(result, delta * scale)
  if (result.length !== 1 || Math.abs(ClipperLib.Clipper.Area(result[0])) < 0.0001 * scale ** 2) throw new Error('Kerf compensation collapses or splits a contour; revise kerf/design')
  return result[0].map(p => ({ x: p.X / scale, y: p.Y / scale }))
}
