import type pg from 'pg'

/**
 * Pembacaan langsung dari basis data service — kebenaran dasar invarian.
 *
 * Uji membaca basis data, bukan hanya API, karena beberapa invarian justru
 * tentang hal yang tidak diperlihatkan API: jumlah booking_events, isi
 * saga_states, dan pembayaran di basis data service LAIN. Menulis ke basis
 * data ini dari uji dilarang — keadaan hanya dicapai lewat alur sungguhan.
 */

export interface BookingRow {
  readonly id: string
  readonly status: string
  readonly version: number
  readonly holdRef: string | null
  readonly heldUntil: Date | null
  readonly paymentId: string | null
  readonly supplierRef: string | null
  readonly refundId: string | null
  readonly userId: string
}

export async function bookingRow(pool: pg.Pool, id: string): Promise<BookingRow | undefined> {
  const result = await pool.query<{
    id: string
    status: string
    version: number
    hold_ref: string | null
    held_until: Date | null
    payment_id: string | null
    supplier_ref: string | null
    refund_id: string | null
    user_id: string
  }>(
    `SELECT id, status, version, hold_ref, held_until, payment_id, supplier_ref, refund_id, user_id
       FROM bookings WHERE id = $1`,
    [id],
  )
  const row = result.rows[0]
  if (row === undefined) return undefined
  return {
    id: row.id,
    status: row.status,
    version: row.version,
    holdRef: row.hold_ref,
    heldUntil: row.held_until,
    paymentId: row.payment_id,
    supplierRef: row.supplier_ref,
    refundId: row.refund_id,
    userId: row.user_id,
  }
}

export async function bookingsOfUser(pool: pg.Pool, userId: string): Promise<readonly string[]> {
  const result = await pool.query<{ id: string }>('SELECT id FROM bookings WHERE user_id = $1', [
    userId,
  ])
  return result.rows.map((row) => row.id)
}

export async function statusesOf(
  pool: pg.Pool,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const result = await pool.query<{ id: string; status: string }>(
    'SELECT id, status FROM bookings WHERE id = ANY($1::uuid[])',
    [ids],
  )
  return new Map(result.rows.map((row) => [row.id, row.status]))
}

export interface EventRow {
  readonly sequence: number
  readonly type: string
}

export async function bookingEvents(pool: pg.Pool, id: string): Promise<readonly EventRow[]> {
  const result = await pool.query<{ sequence: number; event_type: string }>(
    'SELECT sequence, event_type FROM booking_events WHERE booking_id = $1 ORDER BY sequence',
    [id],
  )
  return result.rows.map((row) => ({ sequence: row.sequence, type: row.event_type }))
}

export interface SagaRow {
  readonly step: string
  readonly stepStatus: string
  readonly compensationStatus: string
  readonly leasedUntil: Date | null
}

export async function sagaRow(pool: pg.Pool, bookingId: string): Promise<SagaRow | undefined> {
  const result = await pool.query<{
    current_step: string
    step_status: string
    compensation_status: string
    leased_until: Date | null
  }>(
    `SELECT current_step, step_status, compensation_status, leased_until
       FROM saga_states WHERE booking_id = $1`,
    [bookingId],
  )
  const row = result.rows[0]
  if (row === undefined) return undefined
  return {
    step: row.current_step,
    stepStatus: row.step_status,
    compensationStatus: row.compensation_status,
    leasedUntil: row.leased_until,
  }
}

/** Berapa kali pesan outbox jenis tertentu ditulis untuk satu pemesanan. */
export async function outboxCount(pool: pg.Pool, bookingId: string, type: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*) AS count FROM outbox WHERE booking_id = $1 AND message_type = $2',
    [bookingId, type],
  )
  return Number(result.rows[0]?.count ?? 0)
}

export interface PaymentRow {
  readonly id: string
  readonly bookingId: string
  readonly status: string
}

export async function succeededPayments(pool: pg.Pool): Promise<readonly PaymentRow[]> {
  const result = await pool.query<{ id: string; booking_id: string; status: string }>(
    `SELECT id, booking_id, status FROM payments
      WHERE status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED')`,
  )
  return result.rows.map((row) => ({ id: row.id, bookingId: row.booking_id, status: row.status }))
}

export async function refundsOf(
  pool: pg.Pool,
  paymentId: string,
): Promise<readonly { readonly status: string }[]> {
  const result = await pool.query<{ status: string }>(
    'SELECT status FROM refunds WHERE payment_id = $1',
    [paymentId],
  )
  return result.rows
}
