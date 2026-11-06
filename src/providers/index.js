import { createMockProvider } from './mock.js';
import { createPaystackProvider } from './paystack.js';

export function createProvider({ kind = 'mock', store, secretKey, baseUrl }) {
  if (kind === 'mock') return createMockProvider({ store, baseUrl });
  if (kind === 'paystack') return createPaystackProvider({ secretKey });
  throw new Error(`Unknown PAYMENT_PROVIDER "${kind}". Use "mock" or "paystack".`);
}
