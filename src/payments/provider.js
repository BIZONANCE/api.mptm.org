// ============================================================
// MPTM Payment Provider Interface
// ============================================================

const { PAYMENT_PROVIDER } = require('../config');

let currentProvider = null;

function getPaymentProvider() {
  if (currentProvider) return currentProvider;

  if (PAYMENT_PROVIDER === 'mock') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SECURITY VIOLATION: Mock provider is forbidden in production!');
    }
    currentProvider = require('./mockProvider');
  } else {
    currentProvider = require('./phonepeProvider');
  }

  return currentProvider;
}

module.exports = {
  getPaymentProvider,
};
