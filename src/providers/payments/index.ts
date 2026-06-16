import type { PaymentProvider } from './types';
import { MercadoPagoProvider } from './mercadopago';

export { PaymentProviderError } from './types';
export type { PaymentProvider };

export const REGISTERED_PAYMENT_PROVIDERS = ['mercadopago'] as const;
export type RegisteredPaymentProvider = typeof REGISTERED_PAYMENT_PROVIDERS[number];

const registry = new Map<string, PaymentProvider>();

registry.set('mercadopago', new MercadoPagoProvider());

export function getPaymentProvider(providerName: string): PaymentProvider {
  const provider = registry.get(providerName);
  if (!provider) {
    throw new Error(`Unknown payment provider: "${providerName}". Registered: ${[...registry.keys()].join(', ')}`);
  }
  return provider;
}
