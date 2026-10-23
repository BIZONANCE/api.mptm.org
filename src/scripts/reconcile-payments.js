// ============================================================
// MPTM Payment Reconcile Job
// Usage: node src/scripts/reconcile-payments.js [--dry-run]
// ============================================================

const { PrismaClient } = require('@prisma/client');
const { getPaymentProvider } = require('../payments/provider');
const { finalizeRegistration, finalizeDonation } = require('../services/finalize');
const { recordFailedPayment } = require('../services/failPayment');

const prisma = new PrismaClient();
const isDryRun = process.argv.includes('--dry-run');

async function reconcile() {
  console.log(`[RECONCILE] Starting reconciliation run. DryRun: ${isDryRun}`);

  const now = new Date();
  const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const pendingList = await prisma.pendingPayment.findMany({
    where: {
      status: 'PENDING',
      createdAt: {
        lte: fifteenMinutesAgo,
        gte: twentyFourHoursAgo,
      },
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  console.log(`[RECONCILE] Found ${pendingList.length} candidate pending payments.`);

  let resolvedSuccess = 0;
  let resolvedFailed = 0;
  let stillPending = 0;
  let errorCount = 0;

  for (const pending of pendingList) {
    try {
      console.log(`[RECONCILE] Checking order: ${pending.merchantOrderId} (type: ${pending.type}, amount: ${pending.amountPaise} paise)`);

      const provider = getPaymentProvider(pending.provider || 'phonepe');
      const statusRes = await provider.getStatus(pending.merchantOrderId);

      console.log(`[RECONCILE] Provider result for ${pending.merchantOrderId}: ${statusRes.state}`);

      if (statusRes.state === 'SUCCESS') {
        if (isDryRun) {
          console.log(`[DRY-RUN] Would FINALIZE order ${pending.merchantOrderId}`);
          resolvedSuccess++;
          continue;
        }

        const gatewayResponse = {
          reconciledAt: new Date().toISOString(),
          statusResult: statusRes,
        };

        if (pending.type === 'DONATION') {
          await finalizeDonation(pending.id, {
            paymentReference: statusRes.paymentReference,
            paymentMode: statusRes.paymentMode,
            paymentDetails: gatewayResponse,
          });
        } else {
          await finalizeRegistration(pending.id, {
            paymentReference: statusRes.paymentReference,
            paymentMode: statusRes.paymentMode,
            paymentDetails: gatewayResponse,
          });
        }

        resolvedSuccess++;
        console.log(`[RECONCILE] Successfully finalized order: ${pending.merchantOrderId}`);
      } else if (statusRes.state === 'FAILED') {
        if (isDryRun) {
          console.log(`[DRY-RUN] Would record FAILURE for order ${pending.merchantOrderId}`);
          resolvedFailed++;
          continue;
        }

        await recordFailedPayment({
          pendingPaymentId: pending.id,
          reason: statusRes.raw?.responseMessage || 'Reconcile detected gateway payment failure',
          failureCode: statusRes.raw?.responseCode || 'PAYMENT_ERROR',
          gatewayResponse: statusRes,
        });

        resolvedFailed++;
        console.log(`[RECONCILE] Recorded failure for order: ${pending.merchantOrderId}`);
      } else {
        stillPending++;
        console.log(`[RECONCILE] Order ${pending.merchantOrderId} is still pending at gateway.`);
      }
    } catch (err) {
      errorCount++;
      console.error(`[RECONCILE] Error reconciling order ${pending.merchantOrderId}:`, err.message);
    }
  }

  console.log(`[RECONCILE] Run complete. Total checked: ${pendingList.length}, Finalized: ${resolvedSuccess}, Failed: ${resolvedFailed}, Pending: ${stillPending}, Errors: ${errorCount}`);
}

reconcile()
  .catch((e) => {
    console.error('[RECONCILE FATAL]', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
