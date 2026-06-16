import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MercadoPagoProvider } from '../src/providers/payments/mercadopago';
import { getPaymentProvider, PaymentProviderError } from '../src/providers/payments';

const provider = new MercadoPagoProvider();

function mockFetch(status: number, json: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(json),
    text: () => Promise.resolve(JSON.stringify(json)),
  });
}

describe('getPaymentProvider', () => {
  it('returns the Mercado Pago provider', () => {
    expect(getPaymentProvider('mercadopago')).toBeInstanceOf(MercadoPagoProvider);
  });
  it('throws on an unknown provider', () => {
    expect(() => getPaymentProvider('stripe')).toThrow(/Unknown payment provider/);
  });
});

describe('MercadoPagoProvider.createCheckout', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts a preference and returns id + init_point', async () => {
    const fetchSpy = mockFetch(201, { id: 12345, init_point: 'https://mp/checkout' });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await provider.createCheckout({
      accessToken: 'tok', title: 'Membresía', price: 99, currency: 'MXN', externalReference: 'pay-1',
      notificationUrl: 'https://api.test/webhook/payments/mercadopago/bot-1', successUrl: 'https://shop.test',
    });

    expect(result).toEqual({ providerRef: '12345', url: 'https://mp/checkout' });
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain('/checkout/preferences');
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.external_reference).toBe('pay-1');
    expect(body.notification_url).toBe('https://api.test/webhook/payments/mercadopago/bot-1');
    expect(body.items[0]).toMatchObject({ title: 'Membresía', unit_price: 99, currency_id: 'MXN' });
  });

  it('falls back to sandbox_init_point and throws when no URL is returned', async () => {
    vi.stubGlobal('fetch', mockFetch(201, { id: 1, sandbox_init_point: 'https://mp/sandbox' }));
    expect((await provider.createCheckout({ accessToken: 't', title: 'M', price: 1, currency: 'MXN', externalReference: 'p' })).url).toBe('https://mp/sandbox');

    vi.stubGlobal('fetch', mockFetch(201, { id: 1 }));
    await expect(provider.createCheckout({ accessToken: 't', title: 'M', price: 1, currency: 'MXN', externalReference: 'p' })).rejects.toThrow(PaymentProviderError);
  });

  it('throws PaymentProviderError on a non-2xx response', async () => {
    vi.stubGlobal('fetch', mockFetch(401, { message: 'unauthorized' }));
    await expect(provider.createCheckout({ accessToken: 'bad', title: 'M', price: 1, currency: 'MXN', externalReference: 'p' })).rejects.toThrow(/Mercado Pago API error 401/);
  });
});

describe('MercadoPagoProvider.getPayment', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('normalizes provider statuses', async () => {
    const cases: [string, string][] = [
      ['approved', 'approved'],
      ['in_process', 'pending'],
      ['authorized', 'pending'],
      ['rejected', 'rejected'],
      ['refunded', 'rejected'],
      ['weird', 'other'],
    ];
    for (const [raw, expected] of cases) {
      vi.stubGlobal('fetch', mockFetch(200, { status: raw, external_reference: 'pay-1' }));
      const info = await provider.getPayment({ accessToken: 'tok', paymentId: '999' });
      expect(info).toEqual({ status: expected, externalReference: 'pay-1' });
    }
  });
});
