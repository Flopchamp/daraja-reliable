export interface ParsedCallback {
  checkoutRequestId: string;
  merchantRequestId: string | null;
  resultCode: number;
  /** Present only on success. Failed callbacks carry no receipt. */
  receipt: string | null;
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Parse Safaricom's STK callback from the RAW body. Returns null for anything that is not a
 * well-formed STK callback; callers must still answer 200 and retain the raw payload.
 * Pure: never throws.
 */
export function parseStkCallback(raw: string): ParsedCallback | null {
  if (raw.length > MAX_BODY_BYTES) return null;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  const stk = (body as { Body?: { stkCallback?: unknown } } | null)?.Body?.stkCallback;
  if (typeof stk !== 'object' || stk === null) return null;
  const cb = stk as Record<string, unknown>;

  if (typeof cb.CheckoutRequestID !== 'string' || cb.CheckoutRequestID === '') return null;

  // Documented as a number, but accept a numeric string rather than lose a payment over it.
  const code = typeof cb.ResultCode === 'string' && cb.ResultCode.trim() !== '' ? Number(cb.ResultCode) : cb.ResultCode;
  if (typeof code !== 'number' || !Number.isInteger(code)) return null;

  let receipt: string | null = null;
  const items = (cb.CallbackMetadata as { Item?: unknown } | undefined)?.Item;
  if (Array.isArray(items)) {
    for (const it of items) {
      const item = it as { Name?: unknown; Value?: unknown };
      if (item?.Name === 'MpesaReceiptNumber' && typeof item.Value === 'string' && item.Value !== '') {
        receipt = item.Value;
      }
    }
  }

  return {
    checkoutRequestId: cb.CheckoutRequestID,
    merchantRequestId: typeof cb.MerchantRequestID === 'string' ? cb.MerchantRequestID : null,
    resultCode: code,
    receipt,
  };
}
