export const maxCamProgramLines = 50000
export const maxApiProgramLines = 20000
export const maxNcBytes = 2000000

export function ncSizeError(gcode: string, maxLines: number): string | undefined {
  if (gcode.split('\n').length > maxLines || new TextEncoder().encode(gcode).length > maxNcBytes) {
    return `Generated NC exceeds ${maxLines.toLocaleString('en-GB')} lines or 2 MB. Split the drawing.`
  }
}
