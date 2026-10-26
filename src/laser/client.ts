export async function workshopApi<T>(route: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
  const response = await fetch('/workshop-api/' + route, { method, headers: { 'X-Laser-Client': 'laser-marketplace', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'Workshop request failed')
  return result
}
