// ============================================================
// MPTM Numbering Service — Atomic counters & ID formatters
// ============================================================

const { TIMEZONE } = require('../config');

/**
 * Returns the current year as a 4-digit string in Asia/Kolkata timezone.
 */
function getISTYear(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: TIMEZONE,
    year: 'numeric',
  });
  return formatter.format(date);
}

/**
 * Returns current date formatted as DD/MM/YYYY in Asia/Kolkata timezone.
 */
function getISTDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(date);

  const day = parts.find((p) => p.type === 'day').value;
  const month = parts.find((p) => p.type === 'month').value;
  const year = parts.find((p) => p.type === 'year').value;
  return `${day}/${month}/${year}`;
}

/**
 * Pad a sequence number to a minimum of 3 digits.
 * Grows naturally for 4+ digits (e.g. 1000 -> "1000").
 */
function padSeq(seq) {
  return String(seq).padStart(3, '0');
}

/**
 * Formats receipt number based on registration type and sequence.
 * @param {'PRIMARY' | 'EXECUTIVE' | 'DONATION'} type
 * @param {number} seq
 * @param {string} [year]
 */
function formatReceiptNo(type, seq, year = getISTYear()) {
  const p = padSeq(seq);
  if (type === 'EXECUTIVE') {
    return `MPTM-EM-R${p}`;
  }
  if (type === 'DONATION') {
    return `MPTM-${year}-DON-${p}`;
  }
  // PRIMARY default
  return `MPTM-${year}-AMT-R${p}`;
}

/**
 * Formats member number based on registration type and sequence.
 * @param {'PRIMARY' | 'EXECUTIVE'} type
 * @param {number} seq
 * @param {string} [year]
 */
function formatMemberNo(type, seq, year = getISTYear()) {
  const p = padSeq(seq);
  if (type === 'EXECUTIVE') {
    return `MPTM-EM-S${p}`;
  }
  return `MPTM-${year}-AMT-S${p}`;
}

/**
 * Returns counter keys for a given registration type and year.
 */
function getCounterKeys(type, year = getISTYear()) {
  if (type === 'EXECUTIVE') {
    return {
      receiptKey: 'RECEIPT-EM',
      memberKey: 'MEMBER-EM',
    };
  }
  if (type === 'DONATION') {
    return {
      receiptKey: `DONATION-${year}`,
      memberKey: null,
    };
  }
  return {
    receiptKey: `RECEIPT-${year}`,
    memberKey: `MEMBER-${year}`,
  };
}

/**
 * Atomically increments the counter for a given key by `count` inside a transaction.
 * @param {object} tx - Prisma interactive transaction client
 * @param {string} key - Counter key (e.g. 'RECEIPT-2026')
 * @param {number} count - Number of sequences to reserve (default 1)
 * @returns {Promise<{ startSeq: number, endSeq: number, count: number }>}
 */
async function nextSeq(tx, key, count = 1) {
  if (!key || typeof key !== 'string') {
    throw new Error('Counter key must be a valid non-empty string');
  }
  const n = parseInt(count, 10);
  if (isNaN(n) || n <= 0) {
    throw new Error(`Invalid counter count: ${count}`);
  }

  const result = await tx.$queryRaw`
    INSERT INTO "Counter" ("key", "last")
    VALUES (${key}, ${n})
    ON CONFLICT ("key")
    DO UPDATE SET "last" = "Counter"."last" + ${n}
    RETURNING "last";
  `;

  if (!result || result.length === 0) {
    throw new Error(`Failed to advance counter for key: ${key}`);
  }

  const endSeq = Number(result[0].last);
  const startSeq = endSeq - n + 1;

  return { startSeq, endSeq, count: n };
}

module.exports = {
  getISTYear,
  getISTDateString,
  padSeq,
  formatReceiptNo,
  formatMemberNo,
  getCounterKeys,
  nextSeq,
};
