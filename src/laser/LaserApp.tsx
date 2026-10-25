import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import { z } from 'zod'
import { ArrowDownToLine, Check, CircleDot, Layers, Plus, Upload, Workflow } from 'lucide-react'
import { adapters } from './controllers'
import { buildArtifacts, decodedSvg, previewSvg, type Artifact } from './artifacts'
import { compileSheet } from './controllers'
import { bounds, validatePaths } from './geometry'
import { canonical, defaultMachine, defaultMaterial, demoDesign, designSchema, machineSchema, materialSchema, sha256, type Design, type JobRequest, type Machine, type Material, type Plan, type QueueJob, type Settings, type Sheet } from './model'
import { planJob } from './planner'
import './laser.css'

const workspaceSchema = z.object({ machine: machineSchema, material: materialSchema, designs: z.array(designSchema) })
type Workspace = z.infer<typeof workspaceSchema>
const storageKey = 'laser-marketplace-workspace-v1'
const blank: Workspace = { machine: defaultMachine, material: defaultMaterial, designs: [] }
function initialWorkspace(): Workspace {
  try { const raw = localStorage.getItem(storageKey); return raw ? workspaceSchema.parse(JSON.parse(raw)) : blank } catch { return blank }
}
async function api<T>(route: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
  const response = await fetch('/workshop-api/' + route, { method, headers: { 'X-Laser-Client': 'laser-marketplace', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'Workshop request failed')
  return result
}
function download(artifact: Artifact) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(artifact.bytes)], { type: artifact.mime }))
  const a = document.createElement('a'); a.href = url; a.download = artifact.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function textArtifact(name: string, value: unknown): Artifact { return { name, mime: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(value, null, 2)) } }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="laser-field"><span>{label}</span>{children}</label> }
function NumberField({ label, value, onChange, min = 0, step = 'any' }: { label: string; value: number; onChange: (value: number) => void; min?: number; step?: string }) {
  return <Field label={label}><input type="number" min={min} step={step} value={Number.isNaN(value) ? '' : value} onChange={e => onChange(e.target.value === '' ? NaN : Number(e.target.value))} /></Field>
}
function Preview({ sheet, machine, decoded = false, savedDecoded }: { sheet: Sheet; machine: Machine; decoded?: boolean; savedDecoded?: string }) {
  const svg = useMemo(() => {
    if (!decoded) return previewSvg(sheet)
    if (savedDecoded) return savedDecoded
    const result = compileSheet(sheet, machine)
    return decodedSvg(result.decoded, machine.bedWidth, machine.bedHeight)
  }, [sheet, machine, decoded, savedDecoded])
  return <img className="laser-preview" alt={decoded ? 'Decoded controller toolpath in machine coordinates' : `Sheet ${sheet.number} compensated cut and score layout`} src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)} />
}
function DesignPreview({ design }: { design: Design }) {
  const box = bounds(design.paths.flatMap(p => p.points)), pad = Math.max(box.width, box.height) * .07 + 1
  return <svg className="laser-design-preview" viewBox={`${box.minX - pad} ${box.minY - pad} ${box.width + pad * 2} ${box.height + pad * 2}`} role="img" aria-label={`${design.name} vector preview`}>
    {design.paths.map(p => <path key={p.id} d={`M${p.points.map(v => `${v.x},${v.y}`).join('L')}${p.closed ? 'Z' : ''}`} fill="none" stroke={p.operation === 'cut' ? '#ef6548' : p.operation === 'score' ? '#477fff' : '#adb6c4'} strokeWidth={.5} vectorEffect="non-scaling-stroke" />)}
  </svg>
}
export default function LaserApp() {
  const [workspace, setWorkspace] = useState(initialWorkspace)
  const { machine, material, designs } = workspace
  const [tab, setTab] = useState('designs'), [selected, setSelected] = useState(''), [units, setUnits] = useState<'auto' | 'mm' | 'inches'>('auto')
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [reference, setReference] = useState('BATCH-001'), [quantities, setQuantities] = useState<Record<string, number>>({})
  const [storedArtifacts, setStoredArtifacts] = useState<Artifact[] | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null), [sheetNumber, setSheetNumber] = useState(1), [decoded, setDecoded] = useState(false)
  const [online, setOnline] = useState(false), [jobs, setJobs] = useState<QueueJob[]>([]), [queuePlans, setQueuePlans] = useState<Record<string, Plan>>({})
  const [notes, setNotes] = useState<Record<string, string>>({}), [rejects, setRejects] = useState<Record<string, string[]>>({})
  const current = designs.find(d => d.id === selected) ?? designs[0]
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(workspace)) } catch { queueMicrotask(() => setError('Browser storage is full. Export a workspace backup before closing this page.')) } }, [workspace])
  useEffect(() => {
    let alive = true
    const refresh = async () => { try { const list = await api<QueueJob[]>('jobs'); if (alive) { setJobs(list); setOnline(true) } } catch { if (alive) setOnline(false) } }
    void refresh(); const timer = setInterval(refresh, 8000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  async function run(action: () => Promise<void> | void) { setBusy(true); setMessage(''); setError(''); try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
  function updateDesign(change: Partial<Design>) {
    if (!current) return
    setWorkspace(w => ({ ...w, designs: w.designs.map(d => d.id === current.id ? { ...d, ...change, revision: d.revision + 1, approved: false } : d) }))
  }
  function updateMaterial(change: Partial<Material>) { setWorkspace(w => ({ ...w, material: { ...w.material, ...change, revision: w.material.revision + 1, approved: false } })) }
  function updateMachine(change: Partial<Machine>) { setWorkspace(w => ({ ...w, machine: { ...w.machine, ...change, revision: w.machine.revision + 1 }, material: { ...w.material, machineRevision: w.machine.revision + 1, revision: w.material.revision + 1, approved: false } })) }
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
    await run(async () => {
      const { importDesign } = await import('./import')
      const design = await importDesign(await file.text(), file.name, units)
      if (designs.some(d => d.sku === design.sku)) design.sku += '-2'
      setWorkspace(w => ({ ...w, designs: [...w.designs, design] })); setSelected(design.id)
      setMessage('Drawing imported. Review dimensions and operation assignments, then approve the revision.')
    })
  }
  function request(): JobRequest {
    const lines = designs.filter(d => quantities[d.id] > 0).map(d => ({ design: d, quantity: quantities[d.id], order: reference }))
    if (!lines.length) throw new Error('Enter a quantity for at least one design')
    return { reference, machine, material, lines }
  }
  async function prepare() { const next = planJob(request()); buildArtifacts(next); setStoredArtifacts(null); setPlan(next); setSheetNumber(1); setMessage('Plan validated and controller output decoded back for comparison.'); }
  async function enqueue() {
    if (!plan) return
    const job = await api<QueueJob>('jobs', 'POST', plan.request, 'ui-' + await sha256(canonical(plan.request)))
    setJobs(await api<QueueJob[]>('jobs')); setMessage(`Saved immutable job ${job.id}.`); setTab('queue')
  }
  async function inspectJob(job: QueueJob) {
    const p = await api<Plan>(`jobs/${job.id}/plan`)
    const manifest = await api<{ files: { name: string; mime: string; hash: string }[] }>(`jobs/${job.id}/manifest`)
    const saved = await Promise.all(manifest.files.map(async file => {
      const response = await fetch(`/workshop-api/jobs/${job.id}/artifacts/${file.name}`, { headers: { 'X-Laser-Client': 'laser-marketplace' } })
      if (!response.ok) throw new Error('Cannot read a saved job artifact')
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (await sha256(bytes) !== file.hash) throw new Error('Saved artifact hash mismatch')
      return { name: file.name, mime: file.mime, bytes }
    }))
    setStoredArtifacts(saved); setQueuePlans(v => ({ ...v, [job.id]: p })); setPlan(p); setSheetNumber(1)
  }
  async function queueAction(job: QueueJob, number: number, action: string, resolution?: string) {
    const key = `${job.id}-${number}`, p = queuePlans[job.id] ?? await api<Plan>(`jobs/${job.id}/plan`), sheet = p.sheets.find(s => s.number === number)!
    const rejected = rejects[key] ?? [], accepted = sheet.placements.map(p => p.id).filter(id => !rejected.includes(id))
    const updated = await api<QueueJob>(`jobs/${job.id}/sheets/${number}/actions`, 'POST', { action, note: notes[key] ?? '', accepted, rejected, resolution })
    setQueuePlans(v => ({ ...v, [job.id]: p })); setJobs(v => v.map(j => j.id === job.id ? updated : j)); setMessage('Workshop record updated.')
  }
  const selectedSheet = plan?.sheets.find(s => s.number === sheetNumber) ?? plan?.sheets[0]
  const artifacts = useMemo(() => storedArtifacts ?? (plan ? buildArtifacts(plan) : []), [plan, storedArtifacts])
  const tabs = [{ id: 'designs', label: 'Design library', icon: Layers }, { id: 'profiles', label: 'Machine & material', icon: CircleDot }, { id: 'batch', label: 'Prepare a batch', icon: Plus }, { id: 'queue', label: 'Workshop queue', icon: Workflow }]
  return <div className="laser-app">
    <header className="laser-header"><div className="laser-brand"><span className="laser-mark">✳</span><div><strong>Laser Marketplace</strong><small>Design to workshop</small></div></div><div className="laser-header-right"><span className={'laser-dot ' + (online ? 'online' : '')} />{online ? 'Workshop connected' : 'Offline planning'}<span className="laser-controller">{machine.controller === 'simulation' ? 'Simulation' : 'Ruida · experimental'}</span></div></header>
    <div className="laser-layout"><aside className="laser-sidebar"><nav aria-label="Laser workflow">{tabs.map(t => <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}><t.icon size={18}/>{t.label}</button>)}</nav><div className="laser-sidebar-note"><strong>Your designs, any controller.</strong><p>Jobs store their own geometry, settings and adapter version. Changing the controller only affects new jobs.</p></div><button className="laser-backup" onClick={() => download(textArtifact('laser-workspace.json', workspace))}><ArrowDownToLine size={16}/> Back up workspace</button><label className="laser-backup">Restore backup<input type="file" accept=".json" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void run(async () => { setWorkspace(workspaceSchema.parse(JSON.parse(await f.text()))); setMessage('Workspace restored. Saved workshop jobs are unchanged.') }) }}/></label></aside>
    <main className="laser-main">
      {error && <div role="alert" className="laser-notice error">{error}</div>}{message && <div role="status" className="laser-notice success">{message}</div>}
      {tab === 'designs' && <><div className="laser-title"><div><span className="laser-eyebrow">01 / VECTOR DESIGNS</span><h1>A library ready to make.</h1><p>Import a drawing, assign operations and approve its dimensions once.</p></div><label className="laser-button primary"><Upload size={16}/> Import SVG / DXF<input type="file" hidden accept=".svg,.dxf" disabled={busy} onChange={importFile}/></label></div>
        <div className="laser-toolbar"><Field label="DXF source units"><select value={units} onChange={e => setUnits(e.target.value as typeof units)}><option value="auto">Read from drawing</option><option value="mm">Millimetres</option><option value="inches">Inches</option></select></Field><button onClick={() => { const d = { ...structuredClone(demoDesign), id: crypto.randomUUID(), sku: `TAG-60-${designs.length + 1}` }; setWorkspace(w => ({ ...w, designs: [...w.designs, d] })); setSelected(d.id) }}>Add sample tag</button><span>Cut <b className="laser-cut">—</b> &nbsp; Score <b className="laser-score">—</b></span></div>
        {!current ? <div className="laser-empty"><Layers size={38}/><h2>Start with a vector drawing</h2><p>SVG and DXF geometry stays in millimetres. Closed paths default to cut; open paths default to score.</p><p>Convert text to paths. Raster engraving will be added separately.</p></div> : <div className="laser-library"><div className="laser-card laser-design-list">{designs.map(d => <button key={d.id} onClick={() => setSelected(d.id)} className={d.id === current.id ? 'selected' : ''}><strong>{d.name}</strong><small>{d.sku} · revision {d.revision}</small><span className={'laser-badge ' + (d.approved ? 'approved' : '')}>{d.approved ? 'Approved' : 'Needs review'}</span></button>)}</div><section className="laser-card"><DesignPreview design={current}/><div className="laser-dimensions">{bounds(current.paths.flatMap(p => p.points)).width.toFixed(2)} × {bounds(current.paths.flatMap(p => p.points)).height.toFixed(2)} mm · {current.paths.length} paths</div><div className="laser-fields"><Field label="Design name"><input value={current.name} onChange={e => updateDesign({ name: e.target.value })}/></Field><Field label="SKU"><input value={current.sku} onChange={e => updateDesign({ sku: e.target.value })}/></Field></div><label className="laser-check"><input type="checkbox" checked={current.allowRotation} onChange={e => updateDesign({ allowRotation: e.target.checked })}/>Allow 90° rotation when the material has no grain restriction</label><table><thead><tr><th>Layer / path</th><th>Geometry</th><th>Operation</th></tr></thead><tbody>{current.paths.map(p => <tr key={p.id}><td>{p.layer}<small>{p.id}</small></td><td>{p.closed ? 'Closed' : 'Open'}</td><td><select aria-label={`Operation for ${p.id}`} value={p.operation} onChange={e => updateDesign({ paths: current.paths.map(v => v.id === p.id ? { ...v, operation: e.target.value as typeof v.operation } : v) })}><option value="cut">Cut</option><option value="score">Score</option><option value="ignore">Ignore</option></select></td></tr>)}</tbody></table><p className="laser-muted">Paths follow vector centre lines; stroke widths and fills are not engraved. Review the preview against your drawing.</p><button className="primary" disabled={current.approved || busy} onClick={() => void run(() => { designSchema.parse(current); validatePaths(current.paths); if (designs.some(d => d.id !== current.id && d.sku === current.sku)) throw new Error('Choose a unique SKU'); setWorkspace(w => ({ ...w, designs: w.designs.map(d => d.id === current.id ? { ...d, approved: true } : d) })); setMessage('Design revision approved.') })}><Check size={16}/>{current.approved ? 'Revision approved' : 'Approve dimensions & operations'}</button></section></div>}
      </>}
      {tab === 'profiles' && <><div className="laser-title"><div><span className="laser-eyebrow">02 / WORKSHOP SETUP</span><h1>Settings that travel with the job.</h1><p>Choose a controller now. Swap its adapter later without redrawing products.</p></div></div><div className="laser-two-col"><section className="laser-card"><h2>Machine</h2><Field label="Name"><input value={machine.name} onChange={e => updateMachine({ name: e.target.value })}/></Field><Field label="Controller adapter"><select value={machine.controller} onChange={e => updateMachine({ controller: e.target.value as Machine['controller'] })}>{Object.values(adapters).map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</select></Field><Field label="Controller model / firmware"><input value={machine.controllerModel} onChange={e => updateMachine({ controllerModel: e.target.value })}/></Field><div className="laser-fields"><NumberField label="Bed width (mm)" value={machine.bedWidth} onChange={v => updateMachine({ bedWidth: v })}/><NumberField label="Bed height (mm)" value={machine.bedHeight} onChange={v => updateMachine({ bedHeight: v })}/><NumberField label="Maximum power (%)" value={machine.maxPower} onChange={v => updateMachine({ maxPower: v })}/></div><p>Origin: top left, absolute millimetres.</p><label className="laser-check"><input type="checkbox" checked={machine.mirrorX} onChange={e => updateMachine({ mirrorX: e.target.checked })}/>Mirror X in the controller output</label><label className="laser-check"><input type="checkbox" checked={machine.mirrorY} onChange={e => updateMachine({ mirrorY: e.target.checked })}/>Mirror Y in the controller output</label><div className="laser-notice">{machine.controller === 'simulation' ? 'Simulation generates files and exercises the queue without communicating with hardware.' : 'Ruida RD export is experimental. The exact board, firmware, orientation and upload-only behaviour must be qualified before a live adapter is enabled.'}</div></section>
        <section className="laser-card"><h2>Material profile <span className={'laser-badge ' + (material.approved ? 'approved' : '')}>{material.approved ? 'Approved' : 'Needs review'}</span></h2><Field label="Material name"><input value={material.name} onChange={e => updateMaterial({ name: e.target.value })}/></Field><div className="laser-fields"><NumberField label="Measured thickness (mm)" value={material.thickness} onChange={v => updateMaterial({ thickness: v })}/><NumberField label="Measured kerf (mm)" value={material.kerf} onChange={v => updateMaterial({ kerf: v })}/><NumberField label="Stock width (mm)" value={material.sheetWidth} onChange={v => updateMaterial({ sheetWidth: v })}/><NumberField label="Stock height (mm)" value={material.sheetHeight} onChange={v => updateMaterial({ sheetHeight: v })}/><NumberField label="Sheet edge margin (mm)" value={material.margin} onChange={v => updateMaterial({ margin: v })}/><NumberField label="Path spacing (mm)" value={material.spacing} onChange={v => updateMaterial({ spacing: v })}/></div><label className="laser-check"><input type="checkbox" checked={material.grainLocked} onChange={e => updateMaterial({ grainLocked: e.target.checked })}/>Grain direction locked — keep every part unrotated</label>
        {(['cut', 'score'] as const).map(op => <fieldset key={op}><legend>{op === 'cut' ? 'Cut' : 'Score'} settings</legend><div className="laser-fields">{([['speedMmS', 'Speed (mm/s)'], ['minPower', 'Min power (%)'], ['maxPower', 'Max power (%)'], ['passes', 'Passes']] as const).map(([key, label]) => <NumberField key={key} label={label} value={material[op][key]} onChange={v => updateMaterial({ [op]: { ...material[op], [key]: v } as Settings })}/>)}</div><label className="laser-check"><input type="checkbox" checked={material[op].airAssist} onChange={e => updateMaterial({ [op]: { ...material[op], airAssist: e.target.checked } })}/>Air assist requested</label></fieldset>)}<Field label="Focus, setup and calibration notes"><textarea value={material.notes} onChange={e => updateMaterial({ notes: e.target.value })}/></Field><p className="laser-muted">Initial values are examples. Use measured settings for your stock and machine. Any edit creates a new revision and requires review.</p><button className="primary" disabled={material.approved || busy} onClick={() => void run(() => { materialSchema.parse(material); machineSchema.parse(machine); if ([material.cut, material.score].some(s => s.maxPower > machine.maxPower)) throw new Error('Profile exceeds machine power limit'); setWorkspace(w => ({ ...w, material: { ...w.material, approved: true } })); setMessage('Material profile approved for this machine revision.') })}><Check size={16}/>Approve profile for this machine</button></section></div></>}
      {tab === 'batch' && <><div className="laser-title"><div><span className="laser-eyebrow">03 / PREPARE & EXPORT</span><h1>From quantities to cut files.</h1><p>Automatic nesting, kerf compensation and inside-first cutting.</p></div><button className="primary" disabled={busy} onClick={() => void run(prepare)}>Prepare batch</button></div><section className="laser-card"><Field label="Order / batch reference"><input value={reference} onChange={e => setReference(e.target.value)}/></Field><p>{material.name} · {material.thickness} mm · {material.sheetWidth} × {material.sheetHeight} mm · {machine.name}</p>{!designs.length ? <p>Add and approve a design in the library first.</p> : <table><thead><tr><th>Product</th><th>Revision</th><th>Quantity</th></tr></thead><tbody>{designs.map(d => <tr key={d.id}><td>{d.sku}<small>{d.name}</small></td><td>{d.revision} · {d.approved ? 'Approved' : 'Review required'}</td><td><input aria-label={`Quantity of ${d.sku}`} className="laser-quantity" type="number" min="0" max="200" step="1" value={quantities[d.id] ?? 0} onChange={e => setQuantities(q => ({ ...q, [d.id]: Number(e.target.value) }))}/></td></tr>)}</tbody></table>}</section>
        {plan && selectedSheet && <section className="laser-card laser-plan"><div className="laser-title"><div><h2>{plan.request.reference}</h2><p>{plan.sheets.length} sheets · {plan.sheets.reduce((n, s) => n + s.placements.length, 0)} components · {adapters[plan.request.machine.controller].label}</p></div><button className="primary" disabled={!online || busy || !!storedArtifacts} onClick={() => void run(enqueue)}>{storedArtifacts ? 'Saved job · original files' : 'Save to workshop queue'}</button></div><div className="laser-notice">This is a frozen preview of the last prepared batch. Prepare again to include any edited quantities, designs or settings.</div><div className="laser-toolbar"><Field label="Sheet"><select value={sheetNumber} onChange={e => setSheetNumber(Number(e.target.value))}>{plan.sheets.map(s => <option key={s.number} value={s.number}>Sheet {s.number} · {s.placements.length} parts</option>)}</select></Field><label className="laser-check"><input type="checkbox" checked={decoded} onChange={e => setDecoded(e.target.checked)}/>Show decoded controller output</label><span>{(selectedSheet.estimatedSeconds / 60).toFixed(1)} min beam-on travel estimate</span></div><Preview sheet={selectedSheet} machine={plan.request.machine} decoded={decoded} savedDecoded={storedArtifacts ? new TextDecoder().decode(storedArtifacts.find(a => a.name === `sheet-${selectedSheet.number}-decoded.svg`)?.bytes) : undefined}/><div className="laser-downloads">{artifacts.filter(a => !a.name.startsWith('sheet-') || a.name.startsWith(`sheet-${selectedSheet.number}.`) || a.name === `sheet-${selectedSheet.number}-decoded.svg`).map(a => <button key={a.name} onClick={() => download(a)}><ArrowDownToLine size={15}/>{a.name}</button>)}</div>{plan.warnings.map(w => <p className="laser-muted" key={w}>{w}</p>)}</section>}
      </>}
      {tab === 'queue' && <><div className="laser-title"><div><span className="laser-eyebrow">04 / WORKSHOP QUEUE</span><h1>One sheet at a time.</h1><p>Staging, operator run records and inspection are separate steps.</p></div><button disabled={!online || busy} onClick={() => void run(async () => { await api('workspace', 'PUT', workspace); setMessage('Catalogue and profiles saved. Incoming SKU orders can now be prepared automatically.') })}>Save catalogue to workshop</button></div>
        {!online && <div className="laser-notice"><strong>Start the local workshop service</strong><p>Run <code>npm run workshop</code> in the laser-marketplace folder. This screen reconnects automatically.</p></div>}
        {online && <div className="laser-toolbar"><span>Transport: simulation only · live hardware transfer disabled</span><button onClick={() => void run(async () => { const saved = await api<Workspace | null>('workspace'); if (!saved) throw new Error('No saved workshop catalogue yet'); setWorkspace(workspaceSchema.parse(saved)); setMessage('Loaded the workshop catalogue.') })}>Load workshop catalogue</button></div>}
        {jobs.length === 0 && <div className="laser-empty"><Workflow size={38}/><h2>No prepared jobs yet</h2><p>Prepare a batch and save it here, or submit a SKU order to the local API.</p></div>}
        {jobs.map(job => <section className="laser-card laser-job" key={job.id}><div className="laser-title"><div><h2>{job.reference}</h2><small>{job.id} · {new Date(job.createdAt).toLocaleString()} · {job.controller}</small></div><button disabled={busy} onClick={() => void run(() => inspectJob(job))}>Load frozen job & files</button></div>{job.sheets.map(s => {
          const key = `${job.id}-${s.number}`, p = queuePlans[job.id]?.sheets.find(v => v.number === s.number)
          return <div className="laser-sheet-record" key={s.number}><div className="laser-toolbar"><strong>Sheet {s.number}</strong><span className={'laser-badge ' + (s.state === 'complete' ? 'approved' : '')}>{s.state.replaceAll('_', ' ')}</span>{s.state === 'complete' && <span>{s.accepted.length} accepted · {s.rejected.length} rejected</span>}</div>{p && <Preview sheet={p} machine={queuePlans[job.id].request.machine}/>}{s.state !== 'complete' && <Field label="Operator note (setup, run observation or inspection)"><input value={notes[key] ?? ''} onChange={e => setNotes(v => ({ ...v, [key]: e.target.value }))}/></Field>}{s.state === 'awaiting_inspection' && <div><p>Mark rejected components; all others will be recorded as accepted.</p>{!p ? <button onClick={() => void run(() => inspectJob(job))}>Load components for inspection</button> : p.placements.map(part => <label className="laser-check" key={part.id}><input type="checkbox" checked={(rejects[key] ?? []).includes(part.id)} onChange={e => setRejects(r => ({ ...r, [key]: e.target.checked ? [...(r[key] ?? []), part.id] : (r[key] ?? []).filter(v => v !== part.id) }))}/>Reject {part.sku} · {part.id}</label>)}</div>}
          <div className="laser-downloads">{s.state === 'ready' && <button disabled={busy || job.controller !== 'simulation'} onClick={() => void run(() => queueAction(job, s.number, 'stage'))}>Stage in simulator</button>}{s.state === 'staged' && <button disabled={busy} onClick={() => void run(() => queueAction(job, s.number, 'record-start'))}>Record operator start</button>}{s.state === 'running' && <button disabled={busy} onClick={() => void run(() => queueAction(job, s.number, 'record-finish'))}>Record run finished</button>}{s.state === 'awaiting_inspection' && <button disabled={busy || !p} onClick={() => void run(() => queueAction(job, s.number, 'inspect'))}>Save inspection</button>}{s.state === 'needs_reconciliation' && (['ready', 'staged', 'awaiting_inspection'] as const).map(resolution => <button key={resolution} disabled={busy} onClick={() => void run(() => queueAction(job, s.number, 'reconcile', resolution))}>Confirm {resolution.replaceAll('_', ' ')}</button>)}</div>{job.controller !== 'simulation' && s.state === 'ready' && <p className="laser-muted">Native file prepared for qualification. Live staging requires a commissioned controller adapter.</p>}</div>
        })}<div className="laser-downloads"><button onClick={() => { void run(async () => { await inspectJob(job); setTab('batch') }) }}>View files</button>{job.sheets.every(s => s.state === 'complete') && job.sheets.some(s => s.rejected.length) && <button onClick={() => void run(async () => { await api(`jobs/${job.id}/replacements`, 'POST', {}); setJobs(await api('jobs')); setMessage('Replacement job prepared from the rejected component quantities.') })}>Prepare replacement job</button>}</div><details><summary>Audit history ({job.events.length})</summary>{job.events.map((event, i) => <p key={i}>{new Date(event.at).toLocaleString()} · sheet {event.sheet} · {event.action} — {event.note}</p>)}</details></section>)}
      </>}
    </main></div>
  </div>
}
