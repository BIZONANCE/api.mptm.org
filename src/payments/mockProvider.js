// ============================================================
// MPTM Mock Payment Provider (For Automated Unit Tests Only)
// ============================================================

if (process.env.NODE_ENV === 'production') {
  throw new Error('SECURITY VIOLATION: Mock provider cannot be loaded in production!');
}

const mockOrders = new Map();

/**
 * Creates a mock order.
 */
async function createOrder({ merchantOrderId, amountPaise, redirectUrl }) {
  mockOrders.set(merchantOrderId, {
    merchantOrderId,
    amountPaise,
    redirectUrl,
    state: 'PENDING',
  });

  return {
    redirectUrl: `${redirectUrl}&mock=1`,
    providerRef: `MOCK-TXN-${merchantOrderId}`,
  };
}

/**
 * Gets mock order status.
 */
async function getStatus(merchantOrderId) {
  const order = mockOrders.get(merchantOrderId) || {
    merchantOrderId,
    amountPaise: 10100,
    state: 'PENDING',
  };

  return {
    state: order.state,
    amountPaise: order.amountPaise,
    paymentMode: 'MOCK_UPI',
    paymentReference: `MOCK-REF-${merchantOrderId}`,
    raw: order,
  };
}

/**
 * Sets mock order status (used by test helpers).
 */
function setMockStatus(merchantOrderId, state) {
  const order = mockOrders.get(merchantOrderId) || { merchantOrderId };
  order.state = state;
  mockOrders.set(merchantOrderId, order);
}

/**
 * Validates mock webhook.
 */
function verifyWebhook(headers, rawBody) {
  return {
    valid: headers['x-mock-signature'] === 'valid',
    event: 'PAYMENT_SUCCESS',
    payload: typeof rawBody === 'string' ? JSON.parse(rawBody || '{}') : rawBody,
  };
}

module.exports = {
  createOrder,
  getStatus,
  setMockStatus,
  verifyWebhook,
};
