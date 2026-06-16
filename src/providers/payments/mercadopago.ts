import type {
  PaymentProvider,
  CreateCheckoutOptions,
  CheckoutResult,
  GetPaymentOptions,
  PaymentInfo,
} from './types';
import { PaymentProviderError } from './types';

const API_BASE = 'https://api.mercadopago.com';

// Mercado Pago Checkout Pro: create a preference and send the payer to its
// `init_point`. Payment status is reconciled by re-fetching the payment from the
// API (authoritative) when the webhook fires — we never trust the webhook body.
export class MercadoPagoProvider implements PaymentProvider {
  async createCheckout(opts: CreateCheckoutOptions): Promise<CheckoutResult> {
    const body: Record<string, unknown> = {
      items: [
        {
          title: opts.title,
          quantity: 1,
          unit_price: opts.price,
          currency_id: opts.currency,
        },
      ],
      external_reference: opts.externalReference,
    };
    if (opts.notificationUrl) body.notification_url = opts.notificationUrl;
    if (opts.successUrl) {
      body.back_urls = { success: opts.successUrl, pending: opts.successUrl, failure: opts.successUrl };
      body.auto_return = 'approved';
    }

    const data = await this.request<{ id: string | number; init_point?: string; sandbox_init_point?: string }>(
      'POST',
      '/checkout/preferences',
      opts.accessToken,
      body,
    );

    const url = data.init_point ?? data.sandbox_init_point;
    if (!url) throw new PaymentProviderError('Mercado Pago did not return a checkout URL');
    return { providerRef: String(data.id), url };
  }

  async getPayment(opts: GetPaymentOptions): Promise<PaymentInfo> {
    const data = await this.request<{ status?: string; external_reference?: string | null }>(
      'GET',
      `/v1/payments/${encodeURIComponent(opts.paymentId)}`,
      opts.accessToken,
    );
    return {
      status: normalizeStatus(data.status),
      externalReference: data.external_reference ?? null,
    };
  }

  private async request<T>(method: 'GET' | 'POST', path: string, accessToken: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new PaymentProviderError(`Mercado Pago API error ${res.status}: ${text}`);
      err.statusCode = res.status;
      throw err;
    }
    return (await res.json()) as T;
  }
}

function normalizeStatus(status: string | undefined): PaymentInfo['status'] {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'pending':
    case 'in_process':
    case 'authorized':
      return 'pending';
    case 'rejected':
    case 'cancelled':
    case 'refunded':
    case 'charged_back':
      return 'rejected';
    default:
      return 'other';
  }
}
