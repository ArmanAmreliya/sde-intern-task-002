import { describe, expect, it } from 'vitest'
import { call, createBill, createHome, type Share } from './helpers'

describe('competing payments', () => {
  it('commits one payment and returns its original result on replay', async () => {
    const { homeId } = await createHome(['Asha', 'Ben', 'Chitra'])
    const bill = await createBill(homeId, 2)
    expect(bill.status).toBe(201)
    expect(bill.body.shares.map((share) => share.amountCents)).toEqual([1, 1, 0])
    const share = bill.body.shares[0]
    if (!share) throw new Error('Expected a share')

    const path = `/api/bills/${bill.body.id}/shares/${share.id}/pay`
    const pay = (key: string) => call<Share>('POST', path, { headers: { 'Idempotency-Key': key } })
    const keys = ['first-key', 'second-key']
    const results = await Promise.all(keys.map(pay))
    expect(results.map((result) => result.status).sort()).toEqual([200, 409])

    const winnerIndex = results.findIndex((result) => result.status === 200)
    const winner = keys[winnerIndex]
    if (!winner) throw new Error('Expected a winning key')
    const replay = await pay(winner)
    expect(replay).toEqual(results[winnerIndex])
  })
})
