// ============================================================
// MPTM Seed Counters Script — Idempotent
// Sets Counter.last = GREATEST(existing last, max sequence found in DB)
// ============================================================

const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

// Helper to extract numeric suffix and key from various receipt and member IDs
function parseId(rawId) {
  if (!rawId || typeof rawId !== 'string') return null;
  const s = rawId.trim();

  // Primary receipt: MPTM-2026-AMT-R001
  let match = s.match(/^MPTM-(\d{4})-AMT-R(\d+)$/i);
  if (match) {
    return { key: `RECEIPT-${match[1]}`, seq: parseInt(match[2], 10) };
  }

  // Primary member: MPTM-2026-AMT-S001
  match = s.match(/^MPTM-(\d{4})-AMT-S(\d+)$/i);
  if (match) {
    return { key: `MEMBER-${match[1]}`, seq: parseInt(match[2], 10) };
  }

  // Executive receipt: MPTM-EM-R001
  match = s.match(/^MPTM-EM-R(\d+)$/i);
  if (match) {
    return { key: 'RECEIPT-EM', seq: parseInt(match[1], 10) };
  }

  // Executive member: MPTM-EM-S001
  match = s.match(/^MPTM-EM-S(\d+)$/i);
  if (match) {
    return { key: 'MEMBER-EM', seq: parseInt(match[1], 10) };
  }

  // Donation receipt: MPTM-2026-DON-001
  match = s.match(/^MPTM-(\d{4})-DON-(\d+)$/i);
  if (match) {
    return { key: `DONATION-${match[1]}`, seq: parseInt(match[2], 10) };
  }

  // Legacy fallback if formatted differently
  match = s.match(/(\d+)$/);
  if (match) {
    return { key: 'RECEIPT-LEGACY', seq: parseInt(match[1], 10) };
  }

  return null;
}

async function seedCounters() {
  console.log('--- Starting Counter Seeding ---');

  const maxByKey = {};

  // 1. Scan MemberRegistration receipts
  const registrations = await prisma.memberRegistration.findMany({
    select: { receiptNo: true },
  });
  console.log(`Found ${registrations.length} existing MemberRegistration records.`);
  for (const reg of registrations) {
    const parsed = parseId(reg.receiptNo);
    if (parsed) {
      maxByKey[parsed.key] = Math.max(maxByKey[parsed.key] || 0, parsed.seq);
    } else {
      console.warn(`[WARN] Skipping unparseable MemberRegistration receiptNo: "${reg.receiptNo}"`);
    }
  }

  // 2. Scan MainMember memberNos
  const members = await prisma.mainMember.findMany({
    select: { memberNo: true },
  });
  console.log(`Found ${members.length} existing MainMember records.`);
  for (const m of members) {
    const parsed = parseId(m.memberNo);
    if (parsed) {
      maxByKey[parsed.key] = Math.max(maxByKey[parsed.key] || 0, parsed.seq);
    } else {
      console.warn(`[WARN] Skipping unparseable MainMember memberNo: "${m.memberNo}"`);
    }
  }

  // 3. Scan Donation receipts
  const donations = await prisma.donation.findMany({
    select: { receiptNo: true },
  });
  console.log(`Found ${donations.length} existing Donation records.`);
  for (const don of donations) {
    const parsed = parseId(don.receiptNo);
    if (parsed) {
      maxByKey[parsed.key] = Math.max(maxByKey[parsed.key] || 0, parsed.seq);
    } else {
      console.warn(`[WARN] Skipping unparseable Donation receiptNo: "${don.receiptNo}"`);
    }
  }

  // Ensure default current-year keys exist with at least 0
  const currentYear = new Date().getFullYear();
  const defaultKeys = [
    `RECEIPT-${currentYear}`,
    `MEMBER-${currentYear}`,
    'RECEIPT-EM',
    'MEMBER-EM',
    `DONATION-${currentYear}`,
  ];

  for (const k of defaultKeys) {
    if (maxByKey[k] === undefined) {
      maxByKey[k] = 0;
    }
  }

  console.log('Target max sequences computed:', maxByKey);

  // 4. Upsert each into Counter table with GREATEST(existing last, maxSeq)
  for (const [key, maxSeq] of Object.entries(maxByKey)) {
    const existing = await prisma.counter.findUnique({
      where: { key },
    });

    const newLast = existing ? Math.max(existing.last, maxSeq) : maxSeq;

    await prisma.counter.upsert({
      where: { key },
      create: { key, last: newLast },
      update: { last: newLast },
    });

    console.log(
      `Counter [${key}]: existing=${existing ? existing.last : 'none'}, foundMax=${maxSeq} => set to ${newLast}`
    );
  }

  console.log('--- Counter Seeding Finished Successfully ---');
}

if (require.main === module) {
  seedCounters()
    .catch((err) => {
      console.error('Counter seeding error:', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

module.exports = {
  seedCounters,
};
