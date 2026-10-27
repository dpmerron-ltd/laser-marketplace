import { useState } from 'react'
import { deadSpaceSchema, type DeadSpace, type Sheet } from './model'

interface Props { sheet: Sheet; spacing: number; busy: boolean; onChange: (zones: DeadSpace[]) => Promise<void> }
export default function DeadSpaceEditor({ sheet, spacing, busy, onChange }: Props) {
  const [editing, setEditing] = useState<string | null>(null)
  const [label, setLabel] = useState(''), [x, setX] = useState('0'), [y, setY] = useState('0')
  const [width, setWidth] = useState('50'), [height, setHeight] = useState('50'), [error, setError] = useState('')
  const zones = sheet.deadSpaces ?? []
  function reset() { setEditing(null); setLabel(''); setError('') }
  async function apply() {
    const values = [x, y, width, height]
    const parsed = deadSpaceSchema.safeParse({ id: editing ?? crypto.randomUUID(), label: label.trim() || `Dead space ${zones.length + 1}`, x: Number(x), y: Number(y), width: Number(width), height: Number(height) })
    if (values.some(v => !v.trim()) || !parsed.success) { setError('Enter a label of up to 160 characters, non-negative X/Y and positive width/height in millimetres.'); return }
    if (parsed.data.x + parsed.data.width > sheet.width || parsed.data.y + parsed.data.height > sheet.height) { setError('The rectangle must fit within this sheet.'); return }
    try { await onChange(editing ? zones.map(z => z.id === editing ? parsed.data : z) : [...zones, parsed.data]); reset() }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not update dead space') }
  }
  async function remove(id: string) {
    try { await onChange(zones.filter(z => z.id !== id)); reset() }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not remove dead space') }
  }
  return <section className="laser-dead-space" aria-label={`Dead space on sheet ${sheet.number}`}>
    <h3>Dead space · sheet {sheet.number}</h3>
    <p>Mark damaged or already-cut areas on this sheet. X and Y are measured from its top-left corner. Nesting keeps {spacing} mm clear and moves overflow onto additional sheets.</p>
    <p className="laser-muted">These areas exclude parts and cutting; laser-off travel can cross them.</p>
    {zones.length > 0 && <ul className="laser-dead-space-list">{zones.map(z => <li key={z.id}><span><strong>{z.label}</strong> · X {z.x}, Y {z.y} · {z.width} × {z.height} mm</span><button disabled={busy} onClick={() => { setEditing(z.id); setLabel(z.label); setX(String(z.x)); setY(String(z.y)); setWidth(String(z.width)); setHeight(String(z.height)); setError('') }}>Edit <span className="laser-sr-only">{z.label}</span></button><button disabled={busy} onClick={() => void remove(z.id)}>Remove <span className="laser-sr-only">{z.label}</span></button></li>)}</ul>}
    <div className="laser-dead-space-fields"><label className="laser-field"><span>Dead space label</span><input value={label} maxLength={160} placeholder="e.g. Knot or previous cutout" onChange={e => setLabel(e.target.value)}/></label>
      {([{ label: 'X (mm)', value: x, set: setX }, { label: 'Y (mm)', value: y, set: setY }, { label: 'Width (mm)', value: width, set: setWidth }, { label: 'Height (mm)', value: height, set: setHeight }]).map(field => <label className="laser-field" key={field.label}><span>{field.label}</span><input type="number" min="0" step="any" value={field.value} onChange={e => field.set(e.target.value)}/></label>)}
    </div>
    {error && <p role="alert" className="laser-notice error">{error}</p>}
    <div className="laser-downloads"><button disabled={busy || !editing && zones.length >= 50} onClick={() => void apply()}>{editing ? 'Save dead space & auto-nest' : 'Add dead space & auto-nest'}</button>{editing && <button disabled={busy} onClick={reset}>Cancel edit</button>}</div>
  </section>
}
