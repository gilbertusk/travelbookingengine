import type { Result } from '@tbe/shared-kernel'
import type {
  HoldResult,
  PriceCheckResult,
  SupplierCode,
  SupplierError,
  SupplierSearchResult,
} from '@tbe/supplier-adapters'
import { callSupplier } from './call-supplier.js'
import type { ResilienceDeps } from './ports.js'

/**
 * Operasi yang aman diulang.
 *
 * Keempatnya hanya membaca atau menahan sementara — mengulangnya tidak
 * menghasilkan apa pun yang permanen. `book` sengaja TIDAK ada di sini; ia
 * punya berkasnya sendiri karena keputusan mengulangnya tidak boleh diambil
 * kebijakan umum.
 *
 * `cancel` termasuk aman: membatalkan pemesanan yang sudah dibatalkan
 * menghasilkan `already_cancelled`, bukan kerusakan.
 */

export interface StayDates {
  readonly checkIn: string
  readonly checkOut: string
}

export interface OperationContext {
  readonly correlationId?: string | undefined
}

export async function search(
  deps: ResilienceDeps,
  supplier: SupplierCode,
  criteria: { readonly city: string; readonly guests: number } & StayDates,
  context: OperationContext = {},
): Promise<Result<SupplierSearchResult, SupplierError>> {
  return await callSupplier(deps, {
    supplier,
    operation: 'search',
    requestPayload: criteria,
    correlationId: context.correlationId,
    run: async () => await deps.registry.get(supplier).search(criteria),
  })
}

export interface RatePlanRequest extends StayDates {
  readonly supplier: SupplierCode
  readonly supplierRatePlanId: string
}

export async function priceCheck(
  deps: ResilienceDeps,
  params: RatePlanRequest,
  context: OperationContext = {},
): Promise<Result<PriceCheckResult, SupplierError>> {
  const { supplier, supplierRatePlanId } = params
  const stay = { checkIn: params.checkIn, checkOut: params.checkOut }

  return await callSupplier(deps, {
    supplier,
    operation: 'priceCheck',
    requestPayload: { supplierRatePlanId, ...stay },
    correlationId: context.correlationId,
    run: async () => await deps.registry.get(supplier).priceCheck(supplierRatePlanId, stay),
  })
}

export interface HoldRequest extends RatePlanRequest {
  readonly guests: number
}

export async function hold(
  deps: ResilienceDeps,
  params: HoldRequest,
  context: OperationContext = {},
): Promise<Result<HoldResult, SupplierError>> {
  const { supplier, supplierRatePlanId, guests } = params
  const stay = { checkIn: params.checkIn, checkOut: params.checkOut }

  return await callSupplier(deps, {
    supplier,
    operation: 'hold',
    requestPayload: { supplierRatePlanId, ...stay, guests },
    correlationId: context.correlationId,
    // Hold tidak idempoten — lihat `mutating` di call-supplier.ts.
    mutating: true,
    run: async () => await deps.registry.get(supplier).hold(supplierRatePlanId, stay, guests),
  })
}

export async function cancel(
  deps: ResilienceDeps,
  supplier: SupplierCode,
  bookingReference: string,
  context: OperationContext = {},
): Promise<Result<void, SupplierError>> {
  return await callSupplier(deps, {
    supplier,
    operation: 'cancel',
    requestPayload: { bookingReference },
    correlationId: context.correlationId,
    run: async () => await deps.registry.get(supplier).cancel(bookingReference),
  })
}
