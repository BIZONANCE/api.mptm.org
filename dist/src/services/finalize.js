// ============================================================
// MPTM Finalize Service — Atomic single-transaction finalization
// ============================================================
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { BLOCK_DUPLICATE_MAIN_MOBILES, RECEIPT_HMAC_SECRET, } = require('../config');
const { getISTYear, getISTDateString, formatReceiptNo, formatMemberNo, getCounterKeys, nextSeq, } = require('./numbering');
const { convertNumberToMarathiWords } = require('./marathiWords');
const defaultPrisma = new PrismaClient();
// Internal transaction concurrency limiter to ensure high-concurrency requests
// never exhaust the cloud database connection pool.
function createConcurrencyLimiter(maxConcurrent = 5) {
    const queue = [];
    let active = 0;
    const next = () => {
        active--;
        if (queue.length > 0) {
            const item = queue.shift();
            active++;
            item.fn().then(item.resolve, item.reject).finally(next);
        }
    };
    return (fn) => new Promise((resolve, reject) => {
        if (active < maxConcurrent) {
            active++;
            fn().then(resolve, reject).finally(next);
        }
        else {
            queue.push({ fn, resolve, reject });
        }
    });
}
const txLimiter = createConcurrencyLimiter(5);
/**
 * Computes receipt HMAC SHA-256 string for tamper-evident receipts.
 */
function computeReceiptHmac(receiptNo, date, amountPaise, memberNos = []) {
    const data = `${receiptNo}|${date}|${amountPaise}|${memberNos.join(',')}`;
    return crypto.createHmac('sha256', RECEIPT_HMAC_SECRET).update(data).digest('hex');
}
/**
 * Finalizes a member registration in ONE atomic database transaction.
 * @param {string|object} pendingPaymentIdOrOptions
 * @param {object} [options] - { actorType, actorId, collectedBy, prismaClient, paymentMode, paymentReference, paymentDetails }
 */
async function finalizeRegistration(pendingPaymentIdOrOptions, options = {}) {
    let pendingPaymentId = pendingPaymentIdOrOptions;
    let opts = options || {};
    if (typeof pendingPaymentIdOrOptions === 'object' && pendingPaymentIdOrOptions !== null) {
        opts = pendingPaymentIdOrOptions;
        pendingPaymentId = opts.pendingPaymentId || opts.id;
    }
    const prisma = opts.prismaClient || defaultPrisma;
    const paymentRef = opts.paymentReference || opts.gatewayTxnId || null;
    const paymentDetails = opts.paymentDetails || opts.gatewayResponse || null;
    const paymentMode = opts.paymentMode;
    return await txLimiter(() => prisma.$transaction(async (tx) => {
        // 1. Lock the PendingPayment row (SELECT ... FOR UPDATE)
        const lockedRows = await tx.$queryRaw `
        SELECT * FROM "PendingPayment"
        WHERE "id" = ${pendingPaymentId}
        FOR UPDATE;
      `;
        if (!lockedRows || lockedRows.length === 0) {
            const err = new Error(`PendingPayment with ID ${pendingPaymentId} not found`);
            err.code = 'PAYMENT_NOT_FOUND';
            throw err;
        }
        const lockedPayment = lockedRows[0];
        // 2. Idempotency: If already finalized, return existing registration
        if (lockedPayment.status === 'SUCCESS') {
            const existingReg = await tx.memberRegistration.findUnique({
                where: { pendingPaymentId: lockedPayment.id },
                include: { mainMembers: true, familyMembers: true },
            });
            if (existingReg) {
                return existingReg;
            }
        }
        if (lockedPayment.status === 'FAILED') {
            const err = new Error('Cannot finalize a payment marked FAILED');
            err.code = 'PAYMENT_ALREADY_FAILED';
            throw err;
        }
        if (lockedPayment.status === 'EXPIRED') {
            const err = new Error('Cannot finalize an EXPIRED payment');
            err.code = 'PAYMENT_EXPIRED';
            throw err;
        }
        const payload = lockedPayment.payload;
        const type = lockedPayment.type || 'PRIMARY';
        // 3. Re-check duplicate main-member mobiles
        if (BLOCK_DUPLICATE_MAIN_MOBILES && Array.isArray(payload.mainMembers)) {
            const mobiles = payload.mainMembers
                .map((m) => m.mobileNo)
                .filter(Boolean);
            if (mobiles.length > 0) {
                const existingMembers = await tx.mainMember.findMany({
                    where: { mobileNo: { in: mobiles } },
                    select: { mobileNo: true, memberNo: true },
                });
                if (existingMembers.length > 0) {
                    const dupList = existingMembers.map((m) => `${m.mobileNo} (${m.memberNo})`).join(', ');
                    const err = new Error(`Mobile number already registered: ${dupList}`);
                    err.code = 'DUPLICATE_MOBILE';
                    err.details = existingMembers;
                    throw err;
                }
            }
        }
        // 4. Time, Year, and Atomic Sequence Generation
        const year = getISTYear();
        const date = getISTDateString();
        const { receiptKey, memberKey } = getCounterKeys(type, year);
        // Advance receipt counter by 1
        const { startSeq: receiptSeq } = await nextSeq(tx, receiptKey, 1);
        const receiptNo = formatReceiptNo(type, receiptSeq, year);
        // Advance member counter by N (for N main members)
        const mainMembersPayload = payload.mainMembers || [];
        const memberCount = mainMembersPayload.length;
        let memberStartSeq = 0;
        let memberNos = [];
        if (memberCount > 0 && memberKey) {
            const memberRes = await nextSeq(tx, memberKey, memberCount);
            memberStartSeq = memberRes.startSeq;
            memberNos = mainMembersPayload.map((_, i) => formatMemberNo(type, memberStartSeq + i, year));
        }
        // 5. Amount & Words & Integrity HMAC
        const amountPaise = Number(lockedPayment.amountPaise);
        const amountRupees = Math.round(amountPaise / 100);
        const amountInWords = convertNumberToMarathiWords(amountRupees);
        const publicToken = crypto.randomBytes(16).toString('hex');
        const receiptHmac = computeReceiptHmac(receiptNo, date, amountPaise, memberNos);
        // 6. Create Registration & Member records
        const registration = await tx.memberRegistration.create({
            data: {
                receiptNo,
                date,
                registrationFee: amountRupees,
                amountInWords,
                address: payload.address || '',
                gaav: payload.gaav || null,
                taluka: payload.taluka || null,
                city: payload.city || 'अमरावती',
                district: payload.district || 'अमरावती',
                state: payload.state || 'महाराष्ट्र',
                country: payload.country || 'भारत',
                pincode: payload.pincode || null,
                paymentMethod: lockedPayment.provider === 'cash' ? 'रोख' : 'ऑनलाइन (PhonePe)',
                referredBy: payload.referredBy || null,
                pendingPaymentId: lockedPayment.id,
                publicToken,
                status: 'ACTIVE',
                paymentMode: paymentMode || (lockedPayment.provider === 'cash' ? 'CASH' : 'ONLINE'),
                paymentReference: paymentRef || lockedPayment.gatewayTxnId || null,
                paymentDetails: paymentDetails || lockedPayment.gatewayResponse || null,
                amountPaise,
                collectedBy: lockedPayment.provider === 'cash' ? (opts.collectedBy || null) : null,
                receiptHmac,
                mainMembers: {
                    create: mainMembersPayload.map((m, idx) => ({
                        srNo: idx + 1,
                        memberNo: memberNos[idx],
                        memberNoSeq: memberStartSeq + idx,
                        fullName: m.fullName,
                        mobileNo: m.mobileNo,
                        prabhagNo: m.prabhagNo || '',
                    })),
                },
                familyMembers: {
                    create: (payload.familyMembers || []).map((f, idx) => ({
                        srNo: idx + 1,
                        name: f.name,
                        relation: f.relation,
                        dob: f.dob || '',
                        occupation: f.occupation || '',
                        mobile: f.mobile || '',
                    })),
                },
            },
            include: {
                mainMembers: true,
                familyMembers: true,
            },
        });
        // 7. Mark PendingPayment as SUCCESS
        await tx.pendingPayment.update({
            where: { id: lockedPayment.id },
            data: {
                status: 'SUCCESS',
                publicToken,
                gatewayTxnId: paymentRef || lockedPayment.gatewayTxnId || undefined,
                gatewayResponse: paymentDetails || lockedPayment.gatewayResponse || undefined,
                completedAt: new Date(),
            },
        });
        // 8. Write Audit Log
        await tx.auditLog.create({
            data: {
                actorType: opts.actorType || (lockedPayment.provider === 'cash' ? 'STAFF' : 'SYSTEM'),
                actorId: opts.actorId || null,
                action: 'REGISTRATION_FINALIZED',
                entity: 'MemberRegistration',
                entityId: registration.id,
                meta: {
                    receiptNo,
                    memberNos,
                    amountPaise,
                    pendingPaymentId: lockedPayment.id,
                    publicToken,
                },
            },
        });
        return registration;
    }, {
        maxWait: 180000,
        timeout: 180000,
    }));
}
/**
 * Finalizes a donation in ONE atomic database transaction.
 * @param {string|object} pendingPaymentIdOrOptions
 * @param {object} [options]
 */
async function finalizeDonation(pendingPaymentIdOrOptions, options = {}) {
    let pendingPaymentId = pendingPaymentIdOrOptions;
    let opts = options || {};
    if (typeof pendingPaymentIdOrOptions === 'object' && pendingPaymentIdOrOptions !== null) {
        opts = pendingPaymentIdOrOptions;
        pendingPaymentId = opts.pendingPaymentId || opts.id;
    }
    const prisma = opts.prismaClient || defaultPrisma;
    const paymentRef = opts.paymentReference || opts.gatewayTxnId || null;
    const paymentDetails = opts.paymentDetails || opts.gatewayResponse || null;
    const paymentMode = opts.paymentMode;
    return await txLimiter(() => prisma.$transaction(async (tx) => {
        // 1. Lock the PendingPayment row
        const lockedRows = await tx.$queryRaw `
        SELECT * FROM "PendingPayment"
        WHERE "id" = ${pendingPaymentId}
        FOR UPDATE;
      `;
        if (!lockedRows || lockedRows.length === 0) {
            const err = new Error(`PendingPayment with ID ${pendingPaymentId} not found`);
            err.code = 'PAYMENT_NOT_FOUND';
            throw err;
        }
        const lockedPayment = lockedRows[0];
        // 2. Idempotency check
        const existingDonation = await tx.donation.findUnique({
            where: { pendingPaymentId: lockedPayment.id },
        });
        if (existingDonation) {
            return existingDonation;
        }
        if (lockedPayment.status === 'FAILED') {
            const err = new Error('Cannot finalize a payment marked FAILED');
            err.code = 'PAYMENT_ALREADY_FAILED';
            throw err;
        }
        const payload = lockedPayment.payload;
        const year = getISTYear();
        const date = getISTDateString();
        const { receiptKey } = getCounterKeys('DONATION', year);
        // 3. Counter sequence
        const { startSeq: receiptSeq } = await nextSeq(tx, receiptKey, 1);
        const receiptNo = formatReceiptNo('DONATION', receiptSeq, year);
        const amountPaise = Number(lockedPayment.amountPaise);
        const amountRupees = Math.round(amountPaise / 100);
        const amountInWords = convertNumberToMarathiWords(amountRupees);
        const publicToken = crypto.randomBytes(16).toString('hex');
        const receiptHmac = computeReceiptHmac(receiptNo, date, amountPaise, []);
        // 4. Create Donation record
        const donation = await tx.donation.create({
            data: {
                receiptNo,
                name: payload.name,
                mobileNo: payload.mobileNo,
                address: payload.address || null,
                gaav: payload.gaav || null,
                taluka: payload.taluka || null,
                city: payload.city || 'अमरावती',
                district: payload.district || 'अमरावती',
                state: payload.state || 'महाराष्ट्र',
                country: payload.country || 'भारत',
                pincode: payload.pincode || null,
                amount: amountRupees,
                amountInWords,
                date,
                pendingPaymentId: lockedPayment.id,
                publicToken,
                status: 'ACTIVE',
                paymentMode: paymentMode || (lockedPayment.provider === 'cash' ? 'CASH' : 'ONLINE'),
                paymentReference: paymentRef || lockedPayment.gatewayTxnId || null,
                paymentDetails: paymentDetails || lockedPayment.gatewayResponse || null,
                amountPaise,
                collectedBy: lockedPayment.provider === 'cash' ? (opts.collectedBy || null) : null,
                receiptHmac,
            },
        });
        // 5. Update PendingPayment
        await tx.pendingPayment.update({
            where: { id: lockedPayment.id },
            data: {
                status: 'SUCCESS',
                publicToken,
                gatewayTxnId: paymentRef || lockedPayment.gatewayTxnId || undefined,
                gatewayResponse: paymentDetails || lockedPayment.gatewayResponse || undefined,
                completedAt: new Date(),
            },
        });
        // 6. Write Audit Log
        await tx.auditLog.create({
            data: {
                actorType: opts.actorType || (lockedPayment.provider === 'cash' ? 'STAFF' : 'SYSTEM'),
                actorId: opts.actorId || null,
                action: 'DONATION_FINALIZED',
                entity: 'Donation',
                entityId: donation.id,
                meta: {
                    receiptNo,
                    amountPaise,
                    pendingPaymentId: lockedPayment.id,
                    publicToken,
                },
            },
        });
        return donation;
    }, {
        maxWait: 180000,
        timeout: 180000,
    }));
}
module.exports = {
    finalizeRegistration,
    finalizeDonation,
    computeReceiptHmac,
};
