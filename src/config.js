// ============================================================
// MPTM System Configuration — Central defaults
// ============================================================

// Environment resolution
const isProd = process.env.NODE_ENV === 'production';
const rawPhonepeEnv = (process.env.PHONEPE_ENVIRONMENT || (isProd ? 'PRODUCTION' : 'SANDBOX')).toUpperCase();
const phonepeEnv = rawPhonepeEnv === 'PRODUCTION' || rawPhonepeEnv === 'PROD' ? 'PRODUCTION' : 'SANDBOX';

// Security audit warning: ensure custom HMAC secret is set in production
if (isProd && (!process.env.RECEIPT_HMAC_SECRET || process.env.RECEIPT_HMAC_SECRET === 'mptm-default-secret-do-not-use-in-production')) {
  console.warn('[SECURITY WARNING] RECEIPT_HMAC_SECRET is not set or using default value in production. Please set a strong random secret in your production .env.');
}


module.exports = {
  // Fees (in Rupees and integer paise)
  PRIMARY_FEE_PER_MEMBER_INR: 101,
  PRIMARY_FEE_PER_MEMBER_PAISE: 101 * 100,
  EXECUTIVE_FEE_INR: 1001,
  EXECUTIVE_FEE_PAISE: 1001 * 100,

  // 1-Rupee Live Gateway Testing Configuration
  // Set ONE_RUPEE_TEST_MODE=true in .env to globally make all fees ₹1 for live site testing
  ONE_RUPEE_TEST_MODE: process.env.ONE_RUPEE_TEST_MODE === 'true',
  // Allow ₹1 payment when requested via ?test=1 or isTestPayment flag
  ALLOW_TEST_PAYMENT_1_INR: process.env.ALLOW_TEST_PAYMENT_1_INR !== 'false',

  // Limits per registration
  MAX_MAIN_MEMBERS: 10,
  MAX_FAMILY_MEMBERS: 20,

  // Mobile duplicate policy: same mobile cannot register twice as a main member
  BLOCK_DUPLICATE_MAIN_MOBILES: true,

  // Failed payment retention period
  FAILED_PAYMENT_RETENTION_DAYS: 90,

  // Cash policy (no public cash)
  ALLOW_PUBLIC_CASH: process.env.ALLOW_PUBLIC_CASH === 'true',

  // HMAC Secret for receipt integrity checks
  RECEIPT_HMAC_SECRET: process.env.RECEIPT_HMAC_SECRET || 'mptm-default-secret-do-not-use-in-production',

  // Payment provider (phonepe | mock)
  PAYMENT_PROVIDER: process.env.PAYMENT_PROVIDER || 'phonepe',

  // PhonePe configuration (Dynamic: SANDBOX or PRODUCTION)
  PHONEPE_CLIENT_ID: process.env.PHONEPE_CLIENT_ID || '',
  PHONEPE_CLIENT_SECRET: process.env.PHONEPE_CLIENT_SECRET || '',
  PHONEPE_CLIENT_VERSION: Number(process.env.PHONEPE_CLIENT_VERSION || 1),
  PHONEPE_ENVIRONMENT: phonepeEnv,
  PHONEPE_WEBHOOK_USERNAME: process.env.PHONEPE_WEBHOOK_USERNAME || '',
  PHONEPE_WEBHOOK_PASSWORD: process.env.PHONEPE_WEBHOOK_PASSWORD || '',

  // Public frontend base URL
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || 'http://localhost:3000',

  // Timezone for authorative dates and sequences
  TIMEZONE: 'Asia/Kolkata',

  // Pending payment expiry duration in minutes
  PENDING_PAYMENT_EXPIRY_MINUTES: 30,
};
