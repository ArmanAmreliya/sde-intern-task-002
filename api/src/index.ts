import { Hono } from 'hono'

type Home = { id: string; name: string }
type Bill = { id: string; homeId: string; title: string; totalCents: number }
type Share = { id: string; memberId: string; amountCents: number; paidAt: string | null }
type Balance = { memberId: string; name: string; outstandingCents: number }

const app = new Hono<{ Bindings: Env }>()

async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function nonempty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

app.onError((error, c) => {
  console.error(error)
  return c.json({ error: 'Internal server error' }, 500)
})

app.notFound((c) => c.json({ error: 'Route not found' }, 404))

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.get('/api/homes', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, name FROM homes ORDER BY rowid',
  ).all<Home>()
  return c.json({ homes: results })
})

app.post('/api/homes', async (c) => {
  const body = await readObject(c.req.raw)
  if (!body) return c.json({ error: 'Expected a JSON object' }, 400)
  const name = nonempty(body.name)
  if (!name) return c.json({ error: 'Home name is required' }, 422)

  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind(id, name).run()
  return c.json({ id, name }, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  const body = await readObject(c.req.raw)
  if (!body) return c.json({ error: 'Expected a JSON object' }, 400)
  const name = nonempty(body.name)
  if (!name) return c.json({ error: 'Member name is required' }, 422)

  const id = crypto.randomUUID()
  const result = await c.env.DB.prepare(
    'INSERT INTO members (id, homeId, name) SELECT ?, id, ? FROM homes WHERE id = ?',
  )
    .bind(id, name, homeId)
    .run()
  if (!result.meta.changes) return c.json({ error: 'Home not found' }, 404)
  return c.json({ id, homeId, name }, 201)
})

app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const body = await readObject(c.req.raw)
  if (!body) return c.json({ error: 'Expected a JSON object' }, 400)
  const title = nonempty(body.title)
  const totalCents = body.totalCents
  if (typeof totalCents !== 'number' || !Number.isSafeInteger(totalCents) || totalCents <= 0) {
    return c.json({ error: 'Total must be a positive whole number of cents' }, 422)
  }
  if (!title) return c.json({ error: 'Bill title is required' }, 422)

  const id = crypto.randomUUID()
  const db = c.env.DB
  // The batch commits the bill and the complete member snapshot together.
  const [created, , shares, home] = await db.batch<Share>([
    db
      .prepare(
        'INSERT INTO bills (id, homeId, title, totalCents) SELECT ?, id, ?, ? FROM homes WHERE id = ? AND EXISTS (SELECT 1 FROM members WHERE homeId = homes.id)',
      )
      .bind(id, title, totalCents, homeId),
    db
      .prepare(`
      INSERT INTO shares (id, homeId, billId, memberId, amountCents)
      SELECT lower(hex(randomblob(16))), bills.homeId, bills.id, members.id,
        bills.totalCents / count(*) OVER () +
        (row_number() OVER (ORDER BY members.position) <= bills.totalCents % count(*) OVER ())
      FROM bills JOIN members ON members.homeId = bills.homeId
      WHERE bills.id = ?
    `)
      .bind(id),
    db
      .prepare(`
      SELECT shares.id, memberId, amountCents, paidAt
      FROM shares JOIN members ON members.id = shares.memberId
      WHERE billId = ? ORDER BY members.position
    `)
      .bind(id),
    db.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId),
  ])

  if (!home?.results.length) return c.json({ error: 'Home not found' }, 404)
  if (!created?.meta.changes) return c.json({ error: 'Home has no members' }, 422)
  if (!shares) throw new Error('Missing shares result')
  return c.json({ id, homeId, title, totalCents, shares: shares.results }, 201)
})

app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const db = c.env.DB
  const [home, bills, shares] = await db.batch([
    db.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId),
    db
      .prepare('SELECT id, homeId, title, totalCents FROM bills WHERE homeId = ? ORDER BY position')
      .bind(homeId),
    db
      .prepare(`
      SELECT shares.id, billId, memberId, amountCents, paidAt, members.name AS memberName
      FROM shares JOIN members ON members.id = shares.memberId
      WHERE shares.homeId = ? ORDER BY members.position
    `)
      .bind(homeId),
  ])

  if (!home?.results.length) return c.json({ error: 'Home not found' }, 404)
  const sharesByBill = new Map<string, (Share & { memberName: string })[]>()
  for (const { billId, ...share } of (shares?.results ?? []) as (Share & {
    billId: string
    memberName: string
  })[]) {
    const group = sharesByBill.get(billId) ?? []
    group.push(share)
    sharesByBill.set(billId, group)
  }
  return c.json({
    bills: ((bills?.results ?? []) as Bill[]).map((bill) => ({
      ...bill,
      shares: sharesByBill.get(bill.id) ?? [],
    })),
  })
})

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const { billId, shareId } = c.req.param()
  const key = c.req.header('Idempotency-Key')?.trim()
  if (!key) return c.json({ error: 'Idempotency-Key is required' }, 400)

  const db = c.env.DB
  const [, lookup] = await db.batch<Share & { paymentKey: string }>([
    db
      .prepare(
        'UPDATE shares SET paidAt = ?, paymentKey = ? WHERE billId = ? AND id = ? AND paidAt IS NULL',
      )
      .bind(new Date().toISOString(), key, billId, shareId),
    db
      .prepare(
        'SELECT id, memberId, amountCents, paidAt, paymentKey FROM shares WHERE billId = ? AND id = ?',
      )
      .bind(billId, shareId),
  ])

  const paid = lookup?.results[0]
  if (!paid) return c.json({ error: 'Bill or share not found' }, 404)
  const { paymentKey, ...share } = paid
  if (paymentKey !== key) return c.json({ error: 'Share already paid' }, 409)
  return c.json(share)
})

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')
  const db = c.env.DB
  const [home, balances] = await db.batch<Balance>([
    db.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId),
    db
      .prepare(`
      SELECT members.id AS memberId, members.name, COALESCE(sum(shares.amountCents), 0) AS outstandingCents
      FROM members
      LEFT JOIN shares ON shares.memberId = members.id AND shares.paidAt IS NULL
      WHERE members.homeId = ?
      GROUP BY members.position ORDER BY members.position
    `)
      .bind(homeId),
  ])

  if (!home?.results.length) return c.json({ error: 'Home not found' }, 404)
  return c.json({ balances: balances?.results ?? [] })
})

export default app
