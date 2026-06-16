// ─── Payment provider interface ───────────────────────────────────────────────
// Each bot brings its own provider credentials (BYO, encrypted). The platform
// never holds global payment keys.

export interface CreateCheckoutOptions {
  accessToken: string;
  title: string;          // shown on the provider checkout page
  price: number;          // unit price in the provider's currency
  currency: string;       // ISO-4217, e.g. 'MXN'
  externalReference: string; // our Payment.id — echoed back by the webhook
  notificationUrl?: string;  // provider posts payment updates here
  successUrl?: string;       // where the payer lands after paying
}

export interface CheckoutResult {
  providerRef: string; // provider-side id (e.g. MercadoPago preference id)
  url: string;         // checkout URL to send to the end-user
}

export interface GetPaymentOptions {
  accessToken: string;
  paymentId: string;
}

export interface PaymentInfo {
  // Normalized status across providers
  status: 'approved' | 'pending' | 'rejected' | 'other';
  externalReference: string | null; // our Payment.id, if the provider returns it
}

export interface PaymentProvider {
  createCheckout(opts: CreateCheckoutOptions): Promise<CheckoutResult>;
  getPayment(opts: GetPaymentOptions): Promise<PaymentInfo>;
}

export class PaymentProviderError extends Error {
  statusCode?: number;
}
