import { createFileRoute } from '@tanstack/react-router'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import './bill-splitter.css'

export const Route = createFileRoute('/')({ component: HomePage })

type Home = { id: string; name: string }
type Member = { memberId: string; name: string; outstandingCents: number }
type Share = {
  id: string
  memberId: string
  memberName: string
  amountCents: number
  paidAt: string | null
}
type Bill = { id: string; title: string; totalCents: number; shares: Share[] }

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    signal: options?.signal ?? AbortSignal.timeout(12000),
  })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      throw new Error(body.error)
    }
    throw new Error(`Request failed (HTTP ${response.status}).`)
  }
  return response.json() as Promise<T>
}

function post<T>(path: string, body: object) {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function errorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'The server took too long to respond. Try again.'
  }
  return error instanceof Error ? error.message : 'Something went wrong. Try again.'
}

function money(cents: number) {
  const amount = BigInt(cents)
  const dollars = (amount / 100n).toLocaleString('en-US')
  return `$${dollars}.${String(amount % 100n).padStart(2, '0')}`
}

function HomePage() {
  const [homes, setHomes] = useState<Home[] | null>(null)
  const [selected, setSelected] = useState('')
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: The counter triggers an explicit reload.
  useEffect(() => {
    let active = true
    request<{ homes: Home[] }>('/homes')
      .then(({ homes }) => {
        if (!active) return
        setHomes(homes)
        setSelected(homes[0]?.id ?? '')
      })
      .catch((error: unknown) => {
        if (active) setLoadError(errorMessage(error))
      })
    return () => {
      active = false
    }
  }, [attempt])

  return (
    <main>
      <header className="page-header">
        <h1>Shared Bill Splitter</h1>
        <p>Split household bills and track what each member owes.</p>
      </header>
      {loadError ? (
        <div className="panel">
          <p role="alert">{loadError}</p>
          <button
            type="button"
            onClick={() => {
              setLoadError('')
              setAttempt(attempt + 1)
            }}
          >
            Retry
          </button>
        </div>
      ) : homes === null ? (
        <p role="status">Loading homes...</p>
      ) : (
        <>
          <section className="panel home-controls" aria-label="Homes">
            {homes.length > 0 && (
              <label>
                Home
                <select value={selected} onChange={(event) => setSelected(event.target.value)}>
                  {homes.map((home) => (
                    <option key={home.id} value={home.id}>
                      {home.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <EntryForm
              label="Home name"
              action="Create home"
              onSubmit={async (name) => {
                const home = await post<Home>('/homes', { name })
                setHomes((previous) => [...(previous ?? []), home])
                setSelected(home.id)
              }}
            />
          </section>
          {selected ? (
            <HomeBills key={selected} homeId={selected} />
          ) : (
            <p className="empty">No homes yet. Create a home to start splitting bills.</p>
          )}
        </>
      )}
    </main>
  )
}

function EntryForm({
  label,
  action,
  onSubmit,
  cents = false,
}: {
  label: string
  action: string
  onSubmit: (name: string, totalCents: number) => Promise<void>
  cents?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const form = event.currentTarget
    const data = new FormData(form)
    setBusy(true)
    setError('')
    try {
      await onSubmit(String(data.get('name')).trim(), Number(data.get('totalCents')))
      form.reset()
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <fieldset disabled={busy}>
        <label>
          {label}
          <input name="name" required />
        </label>
        {cents && (
          <label>
            Total (cents)
            <input name="totalCents" type="number" min="1" step="1" required />
          </label>
        )}
        <button type="submit">{busy ? 'Saving...' : action}</button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form>
  )
}

function HomeBills({ homeId }: { homeId: string }) {
  const [bills, setBills] = useState<Bill[] | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [loadError, setLoadError] = useState('')
  const [revision, setRevision] = useState(0)
  const base = `/homes/${encodeURIComponent(homeId)}`

  // biome-ignore lint/correctness/useExhaustiveDependencies: The counter triggers an explicit reload.
  useEffect(() => {
    let active = true
    Promise.all([
      request<{ bills: Bill[] }>(`${base}/bills`),
      request<{ balances: Member[] }>(`${base}/balances`),
    ])
      .then(([{ bills }, { balances }]) => {
        if (!active) return
        setBills(bills)
        setMembers(balances)
        setLoadError('')
      })
      .catch((error: unknown) => {
        if (active) setLoadError(errorMessage(error))
      })
    return () => {
      active = false
    }
  }, [base, revision])

  function refresh() {
    setRevision((previous) => previous + 1)
  }

  function recordPayment(billId: string, shareId: string, paidAt: string) {
    setBills(
      (previous) =>
        previous?.map((bill) =>
          bill.id === billId
            ? {
                ...bill,
                shares: bill.shares.map((share) =>
                  share.id === shareId ? { ...share, paidAt } : share,
                ),
              }
            : bill,
        ) ?? null,
    )
    refresh()
  }

  return (
    <>
      <div className="setup">
        <section className="panel">
          <h2>Members</h2>
          <EntryForm
            label="Member name"
            action="Add member"
            onSubmit={async (name) => {
              await post(`${base}/members`, { name })
              refresh()
            }}
          />
          {members.length > 0 && (
            <ul className="members">
              {members.map((member) => (
                <li key={member.memberId}>
                  <span>{member.name}</span>
                  <span>{money(member.outstandingCents)} owed</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel">
          <h2>New bill</h2>
          {bills && members.length === 0 && <p>Add a member before creating a bill.</p>}
          <EntryForm
            label="Bill title"
            action="Create bill"
            cents
            onSubmit={async (title, totalCents) => {
              await post(`${base}/bills`, { title, totalCents })
              refresh()
            }}
          />
        </section>
      </div>
      <section className="bills" aria-labelledby="bills-title">
        <h2 id="bills-title">Bills</h2>
        {loadError && (
          <div className="panel">
            <p role="alert">{loadError}</p>
            <button
              type="button"
              onClick={() => {
                setLoadError('')
                refresh()
              }}
            >
              Retry
            </button>
          </div>
        )}
        {bills === null && !loadError && <p role="status">Loading bills...</p>}
        {bills?.length === 0 && <p className="empty">No bills yet.</p>}
        {bills?.map((bill) => (
          <article className="panel bill" key={bill.id}>
            <header>
              <h3>{bill.title}</h3>
              <strong>{money(bill.totalCents)}</strong>
            </header>
            <ul>
              {bill.shares.map((share) => (
                <ShareRow
                  key={share.id}
                  billId={bill.id}
                  share={share}
                  onPaid={(paidAt) => recordPayment(bill.id, share.id, paidAt)}
                />
              ))}
            </ul>
          </article>
        ))}
      </section>
    </>
  )
}

function ShareRow({
  billId,
  share,
  onPaid,
}: {
  billId: string
  share: Share
  onPaid: (paidAt: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const paymentKey = useRef<string | null>(null)

  async function pay() {
    if (busy || share.paidAt) return
    setBusy(true)
    setError('')
    try {
      paymentKey.current ??= crypto.randomUUID()
      const paid = await request<{ paidAt: string }>(
        `/bills/${encodeURIComponent(billId)}/shares/${encodeURIComponent(share.id)}/pay`,
        { method: 'POST', headers: { 'Idempotency-Key': paymentKey.current } },
      )
      if (!paid.paidAt) throw new Error('The server did not confirm payment. Try again.')
      onPaid(paid.paidAt)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="share">
      <div className="share-line">
        <span>{share.memberName}</span>
        <span className="amount">{money(share.amountCents)}</span>
        {share.paidAt ? (
          <span className="paid">Paid</span>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={pay}
            aria-label={`Pay share for ${share.memberName}`}
          >
            {busy ? 'Paying...' : 'Pay'}
          </button>
        )}
      </div>
      {error && !share.paidAt && <p role="alert">{error}</p>}
    </li>
  )
}
