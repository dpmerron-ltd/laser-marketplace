import type { Plan, Sheet } from './model'
import type { Motion } from './controllers/types'
import { compileSheet } from './controllers'
export const xmlEscape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!))
const n = (v: number) => Number(v.toFixed(4))
export function previewSvg(sheet: Sheet) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.width}mm" height="${sheet.height}mm" viewBox="0 0 ${sheet.width} ${sheet.height}"><rect width="100%" height="100%" fill="white"/>${sheet.paths.map(p => `<path data-operation="${p.operation}" d="M${p.points.map(v => `${n(v.x)},${n(v.y)}`).join('L')}${p.closed ? 'Z' : ''}" fill="none" stroke="${p.operation === 'cut' ? '#ef6548' : '#477fff'}" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join('')}</svg>`
}
export function decodedSvg(motions: Motion[], width: number, height: number) {
  let previous = { x: 0, y: 0 }
  const lines = motions.map(m => { const from = previous; previous = m.to; return m.burn ? `<path d="M${n(from.x)},${n(from.y)}L${n(m.to.x)},${n(m.to.y)}" fill="none" stroke="#202b3e" stroke-width="1" vector-effect="non-scaling-stroke"/>` : '' }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/>${lines}</svg>`
}
function csv(s: string | number) { const text = String(s); return '"' + (/^[=+@\-\t\r]/.test(text) ? "'" : '') + text.replace(/"/g, '""') + '"' }
export function cuttingList(plan: Plan) {
  return [['sheet', 'instance', 'order', 'sku', 'design_revision', 'material', 'thickness_mm', 'x_mm', 'y_mm', 'rotated'], ...plan.sheets.flatMap(s => s.placements.map(p => [s.number, p.id, p.order, p.sku, p.revision, plan.request.material.name, plan.request.material.thickness, n(p.x), n(p.y), p.rotated ? 'yes' : 'no']))].map(row => row.map(csv).join(',')).join('\r\n')
}
export function labelsHtml(plan: Plan) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Laser job labels</title><style>body{font:14px system-ui;display:flex;gap:4mm;flex-wrap:wrap}article{box-sizing:border-box;border:1px solid #888;padding:4mm;width:80mm;height:40mm;break-inside:avoid}p{margin:2mm 0}@media print{body{margin:0}}</style></head><body>${plan.sheets.flatMap(s => s.placements.map(p => `<article><strong>${xmlEscape(p.sku)}</strong><p>${xmlEscape(p.name)}</p><p>Order ${xmlEscape(p.order)} · sheet ${s.number} · ${p.id}</p><p>${xmlEscape(plan.request.material.name)} · ${plan.request.material.thickness} mm · rev ${p.revision}</p></article>`)).join('')}</body></html>`
}
export interface Artifact { name: string; mime: string; bytes: Uint8Array }
export function buildArtifacts(plan: Plan): Artifact[] {
  const text = (name: string, mime: string, value: string): Artifact => ({ name, mime, bytes: new TextEncoder().encode(value) })
  const result = [text('plan.json', 'application/json', JSON.stringify(plan, null, 2)), text('cutting-list.csv', 'text/csv', cuttingList(plan)), text('labels.html', 'text/html', labelsHtml(plan))]
  for (const sheet of plan.sheets) {
    const { bytes, decoded, adapter } = compileSheet(sheet, plan.request.machine)
    result.push({ name: `sheet-${sheet.number}.${adapter.extension}`, mime: 'application/octet-stream', bytes }, text(`sheet-${sheet.number}.svg`, 'image/svg+xml', previewSvg(sheet)), text(`sheet-${sheet.number}-decoded.svg`, 'image/svg+xml', decodedSvg(decoded, plan.request.machine.bedWidth, plan.request.machine.bedHeight)))
  }
  return result
}
