// ============================================================
// MPTM Fee Calculation Service — Server is Authoritative
// ============================================================

const {
  PRIMARY_FEE_PER_MEMBER_INR,
  PRIMARY_FEE_PER_MEMBER_PAISE,
  EXECUTIVE_FEE_INR,
  EXECUTIVE_FEE_PAISE,
  ONE_RUPEE_TEST_MODE,
  ALLOW_TEST_PAYMENT_1_INR,
} = require('../config');

/**
 * Computes fee for a registration. Client-supplied amounts are ignored.
 * If 1-Rupee test mode is active (via ONE_RUPEE_TEST_MODE in .env or isTestPayment flag),
 * sets fee to ₹1 (100 paise) so real live gateway payments can be safely tested with ₹1.
 * @param {'PRIMARY' | 'EXECUTIVE' | 'DONATION'} type
 * @param {object} payload
 * @returns {{ amountRupees: number, amountPaise: number }}
 */
function computeRegistrationFee(type, payload = {}) {
  // Check if 1-Rupee Live Testing is requested and authorized
  const isTestRequested = Boolean(payload && payload.isTestPayment);
  const isTestActive = ONE_RUPEE_TEST_MODE || (isTestRequested && ALLOW_TEST_PAYMENT_1_INR);

  if (isTestActive) {
    return {
      amountRupees: 1,
      amountPaise: 100, // 100 paise = ₹1 (PhonePe PG minimum allowed transaction)
    };
  }

  if (type === 'EXECUTIVE') {
    return {
      amountRupees: EXECUTIVE_FEE_INR,
      amountPaise: EXECUTIVE_FEE_PAISE,
    };
  }

  if (type === 'DONATION') {
    const raw = payload.amount;
    const amountRupees = parseInt(raw, 10);
    if (isNaN(amountRupees) || amountRupees <= 0) {
      throw new Error('Donation amount must be a positive integer');
    }
    return {
      amountRupees,
      amountPaise: amountRupees * 100,
    };
  }

  // PRIMARY registration: fee is per main member
  const mainMembers = Array.isArray(payload.mainMembers) ? payload.mainMembers : [];
  const count = Math.max(1, mainMembers.length);
  const amountRupees = count * PRIMARY_FEE_PER_MEMBER_INR;
  const amountPaise = count * PRIMARY_FEE_PER_MEMBER_PAISE;

  return {
    amountRupees,
    amountPaise,
  };
}

module.exports = {
  computeRegistrationFee,
};
