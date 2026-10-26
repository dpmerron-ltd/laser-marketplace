import { z } from 'zod'

const shopSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)
const date = z.string().datetime({ offset: true })
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }).refine(p => !p.hasNextPage || !!p.endCursor, 'Missing pagination cursor')
const lineSchema = z.object({ id: z.string().regex(/^gid:\/\/shopify\/LineItem\/\d+$/), sku: z.string().nullable(), currentQuantity: z.number().int().nonnegative(), unfulfilledQuantity: z.number().int().nonnegative() })
const orderSchema = z.object({ id: z.string().regex(/^gid:\/\/shopify\/Order\/\d+$/), name: z.string().min(1).max(160), updatedAt: date, cancelledAt: date.nullable(), closed: z.boolean(), test: z.boolean(), displayFinancialStatus: z.string().nullable(), displayFulfillmentStatus: z.string(), lineItems: z.object({ nodes: z.array(lineSchema), pageInfo }) })
export interface SourceOrder { id: string; name: string; shop: string; updatedAt: string; cancelledAt: string | null; closed: boolean; test: boolean; financialStatus: string | null; fulfillmentStatus: string; lines: z.infer<typeof lineSchema>[] }
export interface ShopifyConfig { shop: string; accessToken?: string; clientId?: string; clientSecret?: string; pollSeconds: number }
export interface OrderReader { shop: string; read(watchIds: string[]): Promise<{ orders: SourceOrder[]; unavailable: string[] }> }
export function shopifyConfig(env: NodeJS.ProcessEnv): ShopifyConfig | null {
  const shop = env.LASER_SHOPIFY_SHOP?.trim().toLowerCase()
  if (!shop) return null
  if (!shopSchema.safeParse(shop).success) throw new Error('LASER_SHOPIFY_SHOP must be a myshopify.com hostname, without a URL path')
  const accessToken = env.LASER_SHOPIFY_ACCESS_TOKEN?.trim(), clientId = env.LASER_SHOPIFY_CLIENT_ID?.trim(), clientSecret = env.LASER_SHOPIFY_CLIENT_SECRET?.trim()
  if (!accessToken && !(clientId && clientSecret)) throw new Error('Configure a Shopify Admin API token or the app client ID and secret in .env.workshop')
  const pollSeconds = Number(env.LASER_SHOPIFY_POLL_SECONDS ?? 60)
  if (!Number.isInteger(pollSeconds) || pollSeconds < 30 || pollSeconds > 3600) throw new Error('Shopify polling interval must be 30–3600 seconds')
  return { shop, accessToken, clientId, clientSecret, pollSeconds }
}
const fields = 'id name updatedAt cancelledAt closed test displayFinancialStatus displayFulfillmentStatus'
const lineFields = 'nodes { id sku currentQuantity unfulfilledQuantity } pageInfo { hasNextPage endCursor }'
export function createShopifyReader(config: ShopifyConfig, fetcher: typeof fetch = fetch, now = Date.now): OrderReader {
  shopSchema.parse(config.shop)
  let cached: { token: string; expires: number } | undefined
  async function request(url: string, init: RequestInit) {
    try { return await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) }) }
    catch { throw new Error('Shopify could not be reached. No partial sync was applied; the workshop will retry.') }
  }
  async function token(): Promise<string> {
    if (config.accessToken) return config.accessToken
    if (cached && cached.expires > now() + 60000) return cached.token
    const response = await request(`https://${config.shop}/admin/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret }) })
    if (!response.ok) throw new Error('Shopify app authentication failed. Check app installation, credentials and organization ownership.')
    const result = z.object({ access_token: z.string().min(1), expires_in: z.number().positive(), scope: z.string() }).safeParse(await response.json().catch(() => null))
    if (!result.success) throw new Error('Shopify returned an invalid authentication response')
    if (!result.data.scope.split(',').some(s => ['read_orders', 'write_orders'].includes(s.trim()))) throw new Error('The Shopify app requires read_orders access')
    cached = { token: result.data.access_token, expires: now() + result.data.expires_in * 1000 }
    return cached.token
  }
  async function graphql(query: string, variables: unknown): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(`https://${config.shop}/admin/api/2026-10/graphql.json`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await token() }, body: JSON.stringify({ query, variables }) })
      if (response.status === 401 && attempt === 0 && !config.accessToken) { cached = undefined; continue }
      if (response.status === 429) throw new Error('Shopify rate limit reached; syncing will retry with backoff')
      if ([401, 403].includes(response.status)) throw new Error('Shopify denied access. Check the app installation, token and read_orders permission.')
      if (!response.ok) throw new Error('Shopify returned an unavailable response; no partial sync was applied')
      const result = z.object({ data: z.unknown().optional(), errors: z.array(z.object({ extensions: z.object({ code: z.string().optional() }).optional() })).optional() }).safeParse(await response.json().catch(() => null))
      if (!result.success) throw new Error('Shopify returned invalid data')
      if (result.data.errors?.length) throw new Error(result.data.errors.some(e => e.extensions?.code === 'THROTTLED') ? 'Shopify rate limit reached; syncing will retry with backoff' : 'Shopify could not provide complete order data. Check read_orders access and retry.')
      return result.data.data
    }
    throw new Error('Shopify authentication failed')
  }
  async function complete(input: z.infer<typeof orderSchema>): Promise<SourceOrder> {
    const lines = [...input.lineItems.nodes], cursors = new Set<string>()
    let info = input.lineItems.pageInfo
    while (info.hasNextPage) {
      if (cursors.has(info.endCursor!) || cursors.size >= 100) throw new Error('Shopify line-item pagination did not complete')
      cursors.add(info.endCursor!)
      const response = z.object({ order: orderSchema.nullable() }).parse(await graphql(`query LaserOrderLines($id: ID!, $after: String) { order(id: $id) { ${fields} lineItems(first: 100, after: $after) { ${lineFields} } } }`, { id: input.id, after: info.endCursor }))
      if (!response.order || response.order.id !== input.id || response.order.updatedAt !== input.updatedAt) throw new Error('An order changed while its line items were loading. The next sync will retry it.')
      lines.push(...response.order.lineItems.nodes); info = response.order.lineItems.pageInfo
    }
    if (new Set(lines.map(l => l.id)).size !== lines.length) throw new Error('Shopify returned duplicate line items')
    return { id: input.id, shop: config.shop, name: input.name, updatedAt: input.updatedAt, cancelledAt: input.cancelledAt, closed: input.closed, test: input.test, financialStatus: input.displayFinancialStatus, fulfillmentStatus: input.displayFulfillmentStatus, lines }
  }
  return { shop: config.shop, async read(watchIds) {
    const orders = new Map<string, SourceOrder>(), cursors = new Set<string>(), unavailable: string[] = []
    let after: string | null = null
    do {
      const data = z.object({ orders: z.object({ nodes: z.array(orderSchema), pageInfo }) }).parse(await graphql(`query LaserOpenOrders($after: String) { orders(first: 25, after: $after, sortKey: CREATED_AT, query: "status:open financial_status:paid (fulfillment_status:unfulfilled OR fulfillment_status:partial) test:false") { nodes { ${fields} lineItems(first: 25) { ${lineFields} } } pageInfo { hasNextPage endCursor } } }`, { after }))
      for (const order of data.orders.nodes) {
        if (orders.has(order.id)) throw new Error('Shopify order pagination changed during sync; retrying is required')
        orders.set(order.id, await complete(order))
      }
      if (!data.orders.pageInfo.hasNextPage) break
      after = data.orders.pageInfo.endCursor
      if (cursors.has(after!) || cursors.size >= 100) throw new Error('Shopify order pagination did not complete')
      cursors.add(after!)
    } while (after)
    // Paid/open search no longer returns cancelled, refunded, held or fulfilled orders.
    // Re-read known outstanding orders by ID so those changes cannot silently disappear.
    const missing = [...new Set(watchIds)].filter(id => !orders.has(id))
    for (let start = 0; start < missing.length; start += 25) {
      const ids = missing.slice(start, start + 25)
      if (ids.some(id => !/^gid:\/\/shopify\/Order\/\d+$/.test(id))) throw new Error('Invalid stored Shopify order ID')
      const data = z.object({ nodes: z.array(orderSchema.nullable()) }).parse(await graphql(`query LaserTrackedOrders($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { ${fields} lineItems(first: 25) { ${lineFields} } } } }`, { ids }))
      if (data.nodes.length !== ids.length) throw new Error('Shopify returned an incomplete tracked-order response')
      for (let i = 0; i < ids.length; i++) {
        const order = data.nodes[i]
        if (!order) { unavailable.push(ids[i]); continue }
        if (order.id !== ids[i]) throw new Error('Shopify returned an unexpected tracked order')
        orders.set(order.id, await complete(order))
      }
    }
    return { orders: [...orders.values()], unavailable }
  } }
}
