import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import CalibrationPage from './CalibrationPage'
afterEach(cleanup)
it('provides four packs and requires real readings before proposing kerf', () => {
  render(<CalibrationPage />)
  for (const code of ['P3', 'P6', 'M3', 'M6']) expect(screen.getByRole('link', { name: `Download ${code} pack` })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Calculate measured kerf' }))
  expect(screen.getByRole('alert')).toHaveTextContent('calliper')
  for (let i = 1; i <= 3; i++) for (const axis of ['X', 'Y']) {
    fireEvent.change(screen.getByRole('spinbutton', { name: `K${i} Plug ${axis}` }), { target: { value: '19.8' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: `K${i} Hole ${axis}` }), { target: { value: '20.2' } })
  }
  fireEvent.click(screen.getByRole('button', { name: 'Calculate measured kerf' }))
  expect(screen.getByRole('heading', { name: 'Candidate kerf: 0.200 mm' })).toBeInTheDocument()
  fireEvent.change(screen.getByRole('combobox', { name: 'Test material' }), { target: { value: 'mdf-6mm' } })
  expect(screen.queryByText('Candidate kerf: 0.200 mm')).not.toBeInTheDocument()
  expect(screen.getByRole('spinbutton', { name: 'K1 Plug X' })).toHaveValue(null)
})
