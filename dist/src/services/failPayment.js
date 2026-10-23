// ============================================================
// MPTM Failed Payment Service
// ============================================================
const { PrismaClient } = require('@prisma/client');
const { FAILED_PAYMENT_RETENTION_DAYS } = require('../config');
const { finalizeRegistration, finalizeDonation } = require('./finalize');
const defaultPrisma = new PrismaClient();
/**
 * Records a failed payment in the FailedPayment table and updates PendingPayment to FAILED.
 * Creates NO member rows.
 * @param {string} pendingPaymentId
 * @param {string|object} pendingPaymentIdOrOptions
 * @param {object} [gatewayResponse]
 * @param {string} [code]
 * @param {string} [reason]
 * @param {object} [options]
 */
async function recordFailedPayment(pendingPaymentIdOrOptions, gatewayResponse = null, code = null, reason = null, options = {}) {
    let pendingPaymentId = pendingPaymentIdOrOptions;
    let actualGatewayResponse = gatewayResponse;
    let actualCode = code;
    let actualReason = reason;
    let opts = options || {};
    if (typeof pendingPaymentIdOrOptions === 'object' && pendingPaymentIdOrOptions !== null) {
        opts = pendingPaymentIdOrOptions;
        pendingPaymentId = opts.pendingPaymentId || opts.id;
        actualGatewayResponse = opts.gatewayResponse || opts.response || null;
        actualCode = opts.failureCode || opts.code || null;
        actualReason = opts.reason || opts.failureReason || null;
    }
    const prisma = opts.prismaClient || defaultPrisma;
    return await prisma.$transaction(async (tx) => {
        const pending = await tx.pendingPayment.findUnique({
            where: { id: pendingPaymentId },
        });
        if (!pending) {
            const err = new Error(`PendingPayment with ID ${pendingPaymentId} not found`);
            err.code = 'PAYMENT_NOT_FOUND';
            throw err;
        }
        if (pending.status === 'SUCCESS') {
            const err = new Error('Cannot mark an already SUCCESS payment as FAILED');
            err.code = 'INVALID_STATE_TRANSITION';
            throw err;
        }
        const purgeAfter = new Date(Date.now() + FAILED_PAYMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
        // Upsert failed payment record
        const failed = await tx.failedPayment.upsert({
            where: { pendingPaymentId: pending.id },
            create: {
                pendingPaymentId: pending.id,
                type: pending.type,
                payload: pending.payload,
                amountPaise: pending.amountPaise,
                provider: pending.provider,
                gatewayResponse: actualGatewayResponse || undefined,
                failureCode: actualCode ? String(actualCode) : null,
                failureReason: actualReason ? String(actualReason) : null,
                status: 'FAILED',
                purgeAfter,
            },
            update: {
                gatewayResponse: actualGatewayResponse || undefined,
                failureCode: actualCode ? String(actualCode) : null,
                failureReason: actualReason ? String(actualReason) : null,
            },
        });
        // Update PendingPayment status
        await tx.pendingPayment.update({
            where: { id: pending.id },
            data: {
                status: 'FAILED',
                gatewayResponse: actualGatewayResponse || undefined,
            },
        });
        // Write AuditLog
        await tx.auditLog.create({
            data: {
                actorType: opts.actorType || 'SYSTEM',
                actorId: opts.actorId || null,
                action: 'PAYMENT_FAILED',
                entity: 'FailedPayment',
                entityId: failed.id,
                meta: {
                    pendingPaymentId: pending.id,
                    failureCode: actualCode,
                    failureReason: actualReason,
                },
            },
        });
        return failed;
    }, {
        timeout: 15000,
    });
}
/**
 * Recovers a payment that was previously recorded as failed if the gateway later confirms success.
 * If finalization fails (e.g. mobile was taken), marks FailedPayment as REFUND_REQUIRED.
 * @param {string} pendingPaymentId
 * @param {object} [options]
 */
async function recoverFailedPayment(pendingPaymentId, options = {}) {
    const prisma = options.prismaClient || defaultPrisma;
    const failedRecord = await prisma.failedPayment.findUnique({
        where: { pendingPaymentId },
    });
    if (!failedRecord) {
        const err = new Error(`FailedPayment for pending ID ${pendingPaymentId} not found`);
        err.code = 'NOT_FOUND';
        throw err;
    }
    // Temporarily reset PendingPayment to PENDING to permit finalize
    await prisma.pendingPayment.update({
        where: { id: pendingPaymentId },
        data: { status: 'PENDING' },
    });
    try {
        let result;
        if (failedRecord.type === 'DONATION') {
            result = await finalizeDonation(pendingPaymentId, options);
        }
        else {
            result = await finalizeRegistration(pendingPaymentId, options);
        }
        await prisma.failedPayment.update({
            where: { pendingPaymentId },
            data: { status: 'RECOVERED' },
        });
        await prisma.auditLog.create({
            data: {
                actorType: options.actorType || 'SYSTEM',
                action: 'PAYMENT_RECOVERED',
                entity: 'FailedPayment',
                entityId: failedRecord.id,
                meta: { pendingPaymentId },
            },
        });
        return { status: 'RECOVERED', record: result };
    }
    catch (err) {
        // If recovery finalization fails, mark REFUND_REQUIRED
        await prisma.failedPayment.update({
            where: { pendingPaymentId },
            data: {
                status: 'REFUND_REQUIRED',
                failureReason: `Recovery failed: ${err.message}`,
            },
        });
        await prisma.pendingPayment.update({
            where: { id: pendingPaymentId },
            data: { status: 'FAILED' },
        });
        await prisma.auditLog.create({
            data: {
                actorType: options.actorType || 'SYSTEM',
                action: 'PAYMENT_REFUND_REQUIRED',
                entity: 'FailedPayment',
                entityId: failedRecord.id,
                meta: { pendingPaymentId, error: err.message },
            },
        });
        return { status: 'REFUND_REQUIRED', error: err.message };
    }
}
module.exports = {
    recordFailedPayment,
    recoverFailedPayment,
};
