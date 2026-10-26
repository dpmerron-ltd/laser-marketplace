import { useMemo } from 'react'
import { decodedSvg, previewSvg } from './artifacts'
import { compileSheet } from './controllers'
import type { Machine, Sheet } from './model'
export default function SheetPreview({ sheet, machine, decoded = false, savedDecoded }: { sheet: Sheet; machine: Machine; decoded?: boolean; savedDecoded?: string }) {
  const svg = useMemo(() => {
    if (!decoded) return previewSvg(sheet)
    if (savedDecoded) return savedDecoded
    return decodedSvg(compileSheet(sheet, machine).decoded, machine.bedWidth, machine.bedHeight)
  }, [sheet, machine, decoded, savedDecoded])
  return <img className="laser-preview" alt={decoded ? 'Decoded controller toolpath in machine coordinates' : `Sheet ${sheet.number} compensated cut and score layout`} src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)} />
}
