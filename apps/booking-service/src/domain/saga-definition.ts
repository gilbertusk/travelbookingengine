/**
 * Saga pemesanan sebagai DATA (Step 19).
 *
 * Pola orkestrasi, bukan koreografi: booking-service yang memegang kendali,
 * dan urutan langkah beserta kompensasinya dinyatakan di SATU tempat — di
 * sini — bukan tersebar di penangan peristiwa yang masing-masing "tahu" apa
 * yang harus dibalik. Koreografi ditolak karena pertanyaan terpenting saga,
 * "apa yang harus dibalik bila langkah ini gagal", tidak punya jawaban di satu
 * tempat mana pun; jawabannya adalah jumlah dari reaksi lima service.
 *
 * Setiap langkah WAJIB menyatakan kompensasinya, termasuk langkah yang tidak
 * punya apa pun untuk dibalik. "Tidak ada" adalah jawaban yang harus ditulis,
 * dengan alasannya, bukan kolom yang dibiarkan kosong — uji di
 * saga-definition.test.ts menolak langkah tanpa pernyataan itu.
 */

export const SAGA_STEPS = [
  'priceCheck',
  'holdLocal',
  'holdSupplier',
  'awaitPayment',
  'confirmSupplier',
  'issueVoucher',
] as const

export type SagaStep = (typeof SAGA_STEPS)[number]

/**
 * Kompensasi yang benar-benar MELAKUKAN sesuatu.
 *
 * - `releaseLocalHold`: kursi dikembalikan ke slot Redis.
 * - `refundPayment`: perintah `payment.refund` ke payment-service.
 * - `cancelSupplierBooking`: perintah `supplier.cancel` ke supplier-service.
 */
export const DIRECT_COMPENSATIONS = ['releaseLocalHold'] as const
export const OUTBOX_COMPENSATIONS = ['refundPayment', 'cancelSupplierBooking'] as const
export const COMPENSATION_ACTIONS = [...DIRECT_COMPENSATIONS, ...OUTBOX_COMPENSATIONS] as const

export type DirectCompensation = (typeof DIRECT_COMPENSATIONS)[number]
export type OutboxCompensation = (typeof OUTBOX_COMPENSATIONS)[number]
export type CompensationAction = DirectCompensation | OutboxCompensation

/**
 * Cara kompensasi dijalankan, dan kenapa pembedaan ini menentukan.
 *
 * - `outbox`: perintah ditulis ke outbox DALAM transaksi yang sama dengan
 *   perubahan keadaan yang memulai kompensasi. Tidak ada jendela di antara
 *   "keadaan berubah" dan "kompensasi diminta" — keduanya satu commit.
 * - `direct`: efek di luar basis data (Redis) yang tidak dapat ikut transaksi.
 *   Saga MENCATAT niatnya lebih dulu — penunjuk `compensatingStep` dan sewa
 *   waktu — baru menjalankannya. Proses yang mati di antaranya meninggalkan
 *   catatan yang dicari pemulihan.
 */
export type CompensationRoute = 'outbox' | 'direct'

export type Compensation =
  /** Langkahnya tidak mengubah apa pun di luar dirinya. */
  | { readonly kind: 'nothing'; readonly why: string }
  /**
   * Efeknya membalik dirinya sendiri pada waktunya. Bukan operasi kosong yang
   * pura-pura bekerja: tidak ada fungsi yang dipanggil, dan alasannya — beserta
   * batas waktu yang menjaminnya — ditulis di sini.
   */
  | { readonly kind: 'lapses'; readonly why: string }
  /**
   * Rute ikut menentukan aksi yang boleh dipasang — pasangan yang salah,
   * refund lewat jalur langsung misalnya, adalah galat compiler.
   */
  | {
      readonly kind: 'run'
      readonly via: Extract<CompensationRoute, 'direct'>
      readonly action: DirectCompensation
    }
  | {
      readonly kind: 'run'
      readonly via: Extract<CompensationRoute, 'outbox'>
      readonly action: OutboxCompensation
    }

export interface SagaStepDefinition {
  readonly name: SagaStep
  /** Apa yang dikerjakan langkah ini, sebagai kalimat — untuk log dan README. */
  readonly action: string
  /**
   * Boleh DIULANG OTOMATIS oleh saga, tanpa pengguna, ketika hasilnya tidak
   * diketahui atau gagal sementara. Syaratnya idempoten: pengulangan tidak
   * menghasilkan efek kedua.
   *
   * Langkah yang tidak boleh diulang dan ditemukan setengah jalan setelah
   * proses mati DIKOMPENSASI, bukan diulang — lihat recover-sagas.ts.
   */
  readonly retryable: boolean
  readonly compensation: Compensation
}

export const SAGA_DEFINITION: readonly SagaStepDefinition[] = [
  {
    name: 'priceCheck',
    action: 'memastikan harga yang disetujui pengguna sudah diverifikasi ke supplier',
    // Price check dijalankan permintaan pengguna (POST /bookings/price-check)
    // SEBELUM saga ada; langkah ini di saga adalah gerbangnya — perintah hold
    // dicoba terhadap domain tanpa efek. Mengulangnya tanpa pengguna tidak
    // berarti apa-apa: harga baru menuntut persetujuan pengguna (FR-14).
    retryable: false,
    compensation: {
      kind: 'nothing',
      why: 'hanya membaca harga dari supplier; tidak ada yang tertahan atau tertagih',
    },
  },
  {
    name: 'holdLocal',
    action: 'mengambil satu kursi dari slot ketersediaan di Redis (skrip Lua, atomik)',
    // Dijalankan permintaan hold pengguna. Saga tidak mengambil kursi atas nama
    // pengguna yang sudah pergi; proses yang mati di tengahnya dikompensasi.
    retryable: false,
    compensation: { kind: 'run', action: 'releaseLocalHold', via: 'direct' },
  },
  {
    name: 'holdSupplier',
    action: 'menahan rate plan di supplier lewat supplier-service',
    // Hold supplier TIDAK idempoten — tidak ada kunci idempotensi pada
    // operasinya. Mengulangnya menahan unit kedua.
    retryable: false,
    compensation: {
      kind: 'lapses',
      why:
        'tidak ada operasi pelepasan hold di supplier mana pun (adapter, supplier-service, ' +
        'maupun lima supplier simulasi); hold supplier kedaluwarsa sendiri pada expiresAt-nya, ' +
        'dan heldUntil pemesanan tidak pernah lebih akhir dari itu (effectiveHoldUntil)',
    },
  },
  {
    name: 'awaitPayment',
    action: 'menunggu payment.succeeded atau payment.failed dari payment-service',
    retryable: false,
    compensation: { kind: 'run', action: 'refundPayment', via: 'outbox' },
  },
  {
    name: 'confirmSupplier',
    action: 'mengirim supplier.confirm lewat RabbitMQ dan menunggu jawabannya di Kafka',
    // Idempoten terhadap kunci idempotensi supplier (= id pemesanan): perintah
    // yang terkirim ulang mengadopsi pemesanan yang sudah terbentuk (US-05).
    retryable: true,
    compensation: { kind: 'run', action: 'cancelSupplierBooking', via: 'outbox' },
  },
  {
    name: 'issueVoucher',
    action: 'mengirim voucher.generate lewat RabbitMQ',
    // Titik balik saga sudah lewat: kamar terkonfirmasi dan dibayar. Kegagalan
    // di sini diselesaikan MAJU — voucher dicoba lagi — bukan dengan
    // membatalkan pemesanan yang sah. CONFIRMED final (Step 16).
    retryable: true,
    compensation: {
      kind: 'nothing',
      why:
        'sesudah titik balik: pemesanan sudah terkonfirmasi dan dibayar, dan kegagalan ' +
        'penerbitan voucher diselesaikan dengan mencoba lagi, bukan dengan membatalkan',
    },
  },
]

/**
 * Definisi satu langkah. Melempar bila tidak ada — itu cacat program, bukan
 * keadaan yang dapat diantisipasi: SAGA_STEPS dan SAGA_DEFINITION berada di
 * berkas yang sama, dan uji memeriksa keduanya sepakat.
 */
export function definitionOf(step: SagaStep): SagaStepDefinition {
  const definition = SAGA_DEFINITION.find((candidate) => candidate.name === step)
  if (definition === undefined) throw new Error(`langkah saga ${step} tidak punya definisi`)

  return definition
}

function indexOf(step: SagaStep): number {
  return SAGA_STEPS.indexOf(step)
}

/**
 * Rencana kompensasi: langkah-langkah yang SUDAH berhasil, dari yang terakhir
 * mundur ke yang pertama.
 *
 * `through` adalah langkah terakhir yang efeknya harus dibalik. Langkah yang
 * gagal tidak termasuk — efeknya tidak pernah terjadi — kecuali pemanggil
 * menyatakan sebaliknya: konfirmasi supplier yang tiba TERLAMBAT, setelah saga
 * memutuskan gagal, adalah langkah yang ternyata berhasil.
 */
export function compensationPlan(through: SagaStep): readonly SagaStepDefinition[] {
  const last = indexOf(through)

  return SAGA_STEPS.slice(0, last + 1)
    .toReversed()
    .map((step) => definitionOf(step))
}

/** Langkah yang kompensasinya dijalankan sekarang juga, lewat outbox. */
export function outboxCompensations(
  plan: readonly SagaStepDefinition[],
): readonly OutboxCompensation[] {
  return plan.flatMap((step) =>
    step.compensation.kind === 'run' && step.compensation.via === 'outbox'
      ? [step.compensation.action]
      : [],
  )
}

/** Langkah berikutnya — mundur dari `after`, tidak termasuk — yang kompensasinya langsung. */
export function nextDirectCompensation(
  plan: readonly SagaStepDefinition[],
  after?: SagaStep,
): SagaStepDefinition | undefined {
  const start = after === undefined ? 0 : plan.findIndex((step) => step.name === after) + 1

  return plan
    .slice(start)
    .find((step) => step.compensation.kind === 'run' && step.compensation.via === 'direct')
}

/**
 * Aksi kompensasi langsung milik sebuah langkah.
 *
 * Penunjuk kompensasi di saga hanya pernah diarahkan ke langkah berkompensasi
 * langsung — lewat [nextDirectCompensation]. Penunjuk ke langkah lain berarti
 * baris saga dirusak atau pemanggilnya cacat, dan itu dilempar, bukan
 * dilewati: kompensasi yang dilewati diam-diam adalah hold yang tidak pernah
 * dilepas.
 */
export function directActionOf(step: SagaStep): DirectCompensation {
  const compensation = definitionOf(step).compensation
  if (compensation.kind !== 'run' || compensation.via !== 'direct') {
    throw new Error(`langkah ${step} tidak punya kompensasi langsung`)
  }

  return compensation.action
}
