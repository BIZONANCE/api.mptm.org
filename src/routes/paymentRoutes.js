// ============================================================
// MPTM Payment & Registration Routes (Stage C)
// ============================================================

const express = require('express');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const {
  validateRegistrationPayload,
  validateDonationPayload,
} = require('../services/validation');
const { computeRegistrationFee } = require('../services/fee');
const { finalizeRegistration, finalizeDonation, computeReceiptHmac } = require('../services/finalize');
const { recordFailedPayment } = require('../services/failPayment');
const { getPaymentProvider } = require('../payments/provider');
const {
  PUBLIC_BASE_URL,
  ALLOW_PUBLIC_CASH,
  PENDING_PAYMENT_EXPIRY_MINUTES,
  BLOCK_DUPLICATE_MAIN_MOBILES,
} = require('../config');

const router = express.Router();
const prisma = new PrismaClient();

// Helper to sanitize error logs (never log PII, tokens, mobiles)
function safeErrorLog(tag, err) {
  console.error(`[${tag}] ${err.name || 'Error'}: ${err.message}`);
}

// ------------------------------------------------------------
// 1. POST /api/registrations/online/start
// ------------------------------------------------------------
router.post('/registrations/online/start', async (req, res) => {
  try {
    const idempotencyKey = req.headers['idempotency-key'] || req.headers['Idempotency-Key'];
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length < 8) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid Idempotency-Key header.',
      });
    }

    // Validate payload with Zod
    let validatedPayload;
    try {
      validatedPayload = validateRegistrationPayload(req.body);
    } catch (valErr) {
      let message = 'नोंदणी माहिती तपासा';
      const issues = valErr.issues || valErr.errors;
      if (Array.isArray(issues) && issues.length > 0) {
        message = issues.map((e) => e.message).join(' | ');
      } else if (typeof valErr.message === 'string') {
        try {
          const parsed = JSON.parse(valErr.message);
          if (Array.isArray(parsed) && parsed.length > 0) {
            message = parsed.map((e) => e.message).join(' | ');
          }
        } catch (_) {
          message = valErr.message;
        }
      }
      return res.status(400).json({
        success: false,
        error: message,
      });
    }

    // Determine registration type (PRIMARY or EXECUTIVE)
    const type = (validatedPayload.type || req.body.type || 'PRIMARY').toUpperCase() === 'EXECUTIVE'
      ? 'EXECUTIVE'
      : 'PRIMARY';

    // Check if a PendingPayment already exists with this idempotency key
    const existing = await prisma.pendingPayment.findUnique({
      where: { idempotencyKey: idempotencyKey.trim() },
    });

    if (existing) {
      if (existing.status === 'SUCCESS') {
        const reg = await prisma.memberRegistration.findUnique({
          where: { pendingPaymentId: existing.id },
        });
        return res.json({
          success: true,
          status: 'SUCCESS',
          publicToken: existing.publicToken,
          redirectUrl: `${PUBLIC_BASE_URL}/receipt/${existing.publicToken}`,
          merchantOrderId: existing.merchantOrderId,
        });
      }

      // If pending and not expired, return same order
      if (existing.status === 'PENDING' && existing.expiresAt > new Date()) {
        const redirectUrl = `${PUBLIC_BASE_URL}/payment/return?order=${existing.merchantOrderId}`;
        return res.json({
          success: true,
          status: 'PENDING',
          merchantOrderId: existing.merchantOrderId,
          redirectUrl,
        });
      }
    }

    // Pre-check duplicate main member mobiles
    if (BLOCK_DUPLICATE_MAIN_MOBILES && Array.isArray(validatedPayload.mainMembers)) {
      const mobiles = validatedPayload.mainMembers.map((m) => m.mobileNo).filter(Boolean);
      if (mobiles.length > 0) {
        const existingMembers = await prisma.mainMember.findMany({
          where: { mobileNo: { in: mobiles } },
          select: { mobileNo: true, memberNo: true },
        });
        if (existingMembers.length > 0) {
          const dupList = existingMembers.map((m) => `${m.mobileNo} (${m.memberNo})`).join(', ');
          return res.status(400).json({
            success: false,
            code: 'DUPLICATE_MOBILE',
            error: `हा मोबाईल क्रमांक आधीच मुख्य सदस्य म्हणून नोंदणीकृत आहे: ${dupList}`,
            duplicateList: dupList,
            duplicateMembers: existingMembers,
          });
        }
      }
    }

    // Allow isTestPayment ONLY when authorized via PIN 2244
    const pin = req.headers['x-test-pin'] || req.body.testPin || req.body.pin;
    if ((req.headers['x-test-payment'] === '1' || req.body.isTestPayment === true) && (pin === '2244' || req.headers['x-test-pin'] === '2244')) {
      validatedPayload.isTestPayment = true;
    } else {
      validatedPayload.isTestPayment = false;
    }

    // Authoritative server-side fee computation
    const fee = computeRegistrationFee(type, validatedPayload);
    const amountPaise = fee.amountPaise;

    const merchantOrderId = 'MPTM-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const publicToken = crypto.randomBytes(16).toString('hex');
    const returnUrl = `${PUBLIC_BASE_URL}/payment/return?order=${merchantOrderId}`;

    // Create order with payment provider
    const provider = getPaymentProvider();
    const orderRes = await provider.createOrder({
      merchantOrderId,
      amountPaise,
      redirectUrl: returnUrl,
    });

    const expiresAt = new Date(Date.now() + PENDING_PAYMENT_EXPIRY_MINUTES * 60 * 1000);

    // Save PendingPayment
    await prisma.pendingPayment.create({
      data: {
        merchantOrderId,
        idempotencyKey: idempotencyKey.trim(),
        type,
        payload: validatedPayload,
        amountPaise,
        provider: 'phonepe',
        publicToken,
        expiresAt,
        gatewayTxnId: orderRes.providerRef || null,
      },
    });

    return res.status(201).json({
      success: true,
      merchantOrderId,
      redirectUrl: orderRes.redirectUrl,
    });
  } catch (err) {
    safeErrorLog('ONLINE_START_ERROR', err);
    return res.status(500).json({
      success: false,
      error: 'नोंदणी सुरू करताना तांत्रिक अडचण आली. कृपया पुन्हा प्रयत्न करा.',
    });
  }
});

// ------------------------------------------------------------
// 2. POST /api/donations/online/start
// ------------------------------------------------------------
router.post('/donations/online/start', async (req, res) => {
  try {
    const idempotencyKey = req.headers['idempotency-key'] || req.headers['Idempotency-Key'];
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length < 8) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid Idempotency-Key header.',
      });
    }

    let validatedPayload;
    try {
      validatedPayload = validateDonationPayload(req.body);
    } catch (valErr) {
      let message = 'देणगी माहिती तपासा';
      const issues = valErr.issues || valErr.errors;
      if (Array.isArray(issues) && issues.length > 0) {
        message = issues.map((e) => e.message).join(' | ');
      } else if (typeof valErr.message === 'string') {
        try {
          const parsed = JSON.parse(valErr.message);
          if (Array.isArray(parsed) && parsed.length > 0) {
            message = parsed.map((e) => e.message).join(' | ');
          }
        } catch (_) {
          message = valErr.message;
        }
      }
      return res.status(400).json({
        success: false,
        error: message,
      });
    }

    const existing = await prisma.pendingPayment.findUnique({
      where: { idempotencyKey: idempotencyKey.trim() },
    });

    if (existing && existing.status === 'PENDING' && existing.expiresAt > new Date()) {
      return res.json({
        success: true,
        merchantOrderId: existing.merchantOrderId,
        redirectUrl: `${PUBLIC_BASE_URL}/payment/return?order=${existing.merchantOrderId}`,
      });
    }

    if (req.headers['x-test-payment'] === '1' || req.headers['x-test-payment'] === 'true' || req.body.isTestPayment === true) {
      validatedPayload.isTestPayment = true;
    }

    const fee = computeRegistrationFee('DONATION', validatedPayload);
    const amountPaise = fee.amountPaise;

    const merchantOrderId = 'DON-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const publicToken = crypto.randomBytes(16).toString('hex');
    const returnUrl = `${PUBLIC_BASE_URL}/payment/return?order=${merchantOrderId}`;

    const provider = getPaymentProvider();
    const orderRes = await provider.createOrder({
      merchantOrderId,
      amountPaise,
      redirectUrl: returnUrl,
    });

    const expiresAt = new Date(Date.now() + PENDING_PAYMENT_EXPIRY_MINUTES * 60 * 1000);

    await prisma.pendingPayment.create({
      data: {
        merchantOrderId,
        idempotencyKey: idempotencyKey.trim(),
        type: 'DONATION',
        payload: validatedPayload,
        amountPaise,
        provider: 'phonepe',
        publicToken,
        expiresAt,
        gatewayTxnId: orderRes.providerRef || null,
      },
    });

    return res.status(201).json({
      success: true,
      merchantOrderId,
      redirectUrl: orderRes.redirectUrl,
    });
  } catch (err) {
    safeErrorLog('DONATION_START_ERROR', err);
    return res.status(500).json({
      success: false,
      error: 'देणगी नोंदणी सुरू करताना तांत्रिक अडचण आली.',
    });
  }
});

// ------------------------------------------------------------
// 3. POST /api/registrations/cash (Strict safety: staff only, no public cash)
// ------------------------------------------------------------
router.post('/registrations/cash', async (req, res) => {
  if (!ALLOW_PUBLIC_CASH) {
    return res.status(403).json({
      success: false,
      error: 'Public cash registration is disabled. Cash must be collected by authorized staff.',
    });
  }
  return res.status(403).json({
    success: false,
    error: 'Staff authentication required.',
  });
});

// ------------------------------------------------------------
// 3b. GET /api/payments/test-status (Check if 1-Rupee test mode is available)
// ------------------------------------------------------------
router.get('/payments/test-status', (req, res) => {
  const { ONE_RUPEE_TEST_MODE, ALLOW_TEST_PAYMENT_1_INR } = require('../config');
  return res.json({
    success: true,
    oneRupeeTestMode: Boolean(ONE_RUPEE_TEST_MODE),
    allowTestPayment1Inr: Boolean(ALLOW_TEST_PAYMENT_1_INR),
  });
});

// ------------------------------------------------------------
// 4. GET /api/payments/status/:merchantOrderId
// ------------------------------------------------------------
router.get('/payments/status/:merchantOrderId', async (req, res) => {
  try {
    const merchantOrderId = String(req.params.merchantOrderId).trim();

    const pending = await prisma.pendingPayment.findUnique({
      where: { merchantOrderId },
    });

    if (!pending) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    // If already finalized successfully, return receipt token
    if (pending.status === 'SUCCESS') {
      return res.json({
        success: true,
        status: 'SUCCESS',
        state: 'SUCCESS',
        publicToken: pending.publicToken,
      });
    }

    // If already marked FAILED
    if (pending.status === 'FAILED') {
      return res.json({
        success: true,
        status: 'FAILED',
        state: 'FAILED',
        reason: pending.gatewayResponse?.failureReason || 'Payment failed or declined',
      });
    }

    // If PENDING, query authoritative gateway status
    const provider = getPaymentProvider();
    let providerStatus;
    try {
      providerStatus = await provider.getStatus(merchantOrderId);
    } catch (statusErr) {
      safeErrorLog('GET_STATUS_GATEWAY_ERROR', statusErr);
      return res.json({
        success: true,
        status: 'PENDING',
        message: 'Checking with bank...',
      });
    }

    if (providerStatus.state === 'SUCCESS') {
      // Amount verification: reported amount must match pending order amount
      if (providerStatus.amountPaise !== pending.amountPaise) {
        console.error(`[CRITICAL] Amount mismatch on order ${merchantOrderId}: expected ${pending.amountPaise}, got ${providerStatus.amountPaise}`);
        await recordFailedPayment(
          pending.id,
          providerStatus.raw,
          'AMOUNT_MISMATCH',
          'Payment amount reported by gateway does not match order fee. Marked for refund.'
        );
        return res.json({
          success: true,
          status: 'FAILED',
          reason: 'Amount mismatch detected. Transaction flagged for refund.',
        });
      }

      // Finalize registration or donation
      let record;
      if (pending.type === 'DONATION') {
        record = await finalizeDonation(pending.id, {
          paymentMode: providerStatus.paymentMode,
          paymentReference: providerStatus.paymentReference,
          paymentDetails: providerStatus.raw,
        });
      } else {
        record = await finalizeRegistration(pending.id, {
          paymentMode: providerStatus.paymentMode,
          paymentReference: providerStatus.paymentReference,
          paymentDetails: providerStatus.raw,
        });
      }

      return res.json({
        success: true,
        status: 'SUCCESS',
        state: 'SUCCESS',
        publicToken: pending.publicToken,
        receiptNo: record.receiptNo,
      });
    }

    if (providerStatus.state === 'FAILED') {
      await recordFailedPayment(
        pending.id,
        providerStatus.raw,
        providerStatus.raw?.responseCode || 'FAILED',
        'Payment failed or was cancelled by user'
      );
      return res.json({
        success: true,
        status: 'FAILED',
        state: 'FAILED',
        reason: 'Payment failed at gateway.',
      });
    }

    // Still PENDING
    return res.json({
      success: true,
      status: 'PENDING',
      state: 'PENDING',
    });
  } catch (err) {
    safeErrorLog('PAYMENT_STATUS_ROUTE_ERROR', err);
    return res.status(500).json({
      success: false,
      error: 'Status check error',
    });
  }
});

// ------------------------------------------------------------
// 5. POST /api/payments/webhook/:provider
// ------------------------------------------------------------
router.post('/payments/webhook/:providerName', async (req, res) => {
  try {
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const provider = getPaymentProvider();

    const verification = provider.verifyWebhook(req.headers, rawBody);
    const eventId = req.headers['x-event-id'] || verification.payload?.merchantOrderId || crypto.randomUUID();

    // Log to WebhookLog
    const webhookLog = await prisma.webhookLog.create({
      data: {
        provider: req.params.providerName,
        eventId,
        rawBody,
        signatureValid: verification.valid,
      },
    });

    if (!verification.valid) {
      console.warn(`[WEBHOOK] Invalid webhook signature from ${req.params.providerName}`);
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const payload = verification.payload || {};
    const merchantOrderId = payload.merchantOrderId;

    if (merchantOrderId) {
      const pending = await prisma.pendingPayment.findUnique({
        where: { merchantOrderId },
      });

      if (pending && pending.status === 'PENDING') {
        const state = payload.state;
        if (state === 'COMPLETED') {
          if (pending.type === 'DONATION') {
            await finalizeDonation(pending.id, { paymentDetails: payload });
          } else {
            await finalizeRegistration(pending.id, { paymentDetails: payload });
          }
        } else if (state === 'FAILED') {
          await recordFailedPayment(pending.id, payload, 'WEBHOOK_FAILED', 'Failed state received from webhook');
        }
      }
    }

    await prisma.webhookLog.update({
      where: { id: webhookLog.id },
      data: { processedAt: new Date() },
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    safeErrorLog('WEBHOOK_ERROR', err);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ------------------------------------------------------------
// 6. GET /api/receipts/:publicToken
// ------------------------------------------------------------
router.get('/receipts/:publicToken', async (req, res) => {
  try {
    const publicToken = String(req.params.publicToken).trim();

    // Check MemberRegistration
    const registration = await prisma.memberRegistration.findFirst({
      where: { publicToken, status: 'ACTIVE' },
      include: {
        mainMembers: { orderBy: { srNo: 'asc' } },
        familyMembers: { orderBy: { srNo: 'asc' } },
      },
    });

    if (registration) {
      return res.json({
        success: true,
        type: 'REGISTRATION',
        data: {
          receiptNo: registration.receiptNo,
          date: registration.date,
          fee: registration.registrationFee,
          registrationFee: registration.registrationFee,
          amount: registration.registrationFee,
          amountInWords: registration.amountInWords,
          address: registration.address,
          gaav: registration.gaav,
          taluka: registration.taluka,
          city: registration.city,
          district: registration.district,
          state: registration.state,
          country: registration.country,
          pincode: registration.pincode,
          paymentMode: registration.paymentMode || 'ONLINE',
          paymentReference: registration.paymentReference,
          mainMembers: registration.mainMembers.map((m) => ({
            srNo: m.srNo,
            memberNo: m.memberNo,
            fullName: m.fullName,
            mobileNo: m.mobileNo,
            prabhagNo: m.prabhagNo,
          })),
          familyMembers: registration.familyMembers.map((f) => ({
            srNo: f.srNo,
            name: f.name,
            relation: f.relation,
            dob: f.dob,
            occupation: f.occupation,
            mobile: f.mobile,
          })),
          publicToken: registration.publicToken,
          receiptHmac: registration.receiptHmac,
          verifyUrl: `${PUBLIC_BASE_URL}/verify/${registration.publicToken}`,
        },
      });
    }

    // Check Donation
    const donation = await prisma.donation.findFirst({
      where: { publicToken, status: 'ACTIVE' },
    });

    if (donation) {
      return res.json({
        success: true,
        type: 'DONATION',
        data: {
          receiptNo: donation.receiptNo,
          name: donation.name,
          mobileNo: donation.mobileNo,
          amount: donation.amount,
          fee: donation.amount,
          registrationFee: donation.amount,
          amountInWords: donation.amountInWords,
          date: donation.date,
          address: donation.address,
          city: donation.city,
          district: donation.district,
          paymentMode: donation.paymentMode || 'ONLINE',
          paymentReference: donation.paymentReference,
          publicToken: donation.publicToken,
          receiptHmac: donation.receiptHmac,
          verifyUrl: `${PUBLIC_BASE_URL}/verify/${donation.publicToken}`,
        },
      });
    }

    return res.status(404).json({
      success: false,
      error: 'Receipt not found or is no longer active.',
    });
  } catch (err) {
    safeErrorLog('GET_RECEIPT_ERROR', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ------------------------------------------------------------
// 7. GET /api/verify/:publicToken
// ------------------------------------------------------------
router.get('/verify/:publicToken', async (req, res) => {
  try {
    const publicToken = String(req.params.publicToken).trim();

    const reg = await prisma.memberRegistration.findFirst({
      where: { publicToken, status: 'ACTIVE' },
      include: { mainMembers: { select: { memberNo: true } } },
    });

    if (reg) {
      const memberNos = reg.mainMembers.map((m) => m.memberNo);
      const expectedHmac = computeReceiptHmac(
        reg.receiptNo,
        reg.date,
        reg.amountPaise || reg.registrationFee * 100,
        memberNos
      );
      const valid = Boolean(reg.receiptHmac && reg.receiptHmac === expectedHmac);

      return res.json({
        success: true,
        valid,
        type: 'REGISTRATION',
        receiptNo: reg.receiptNo,
        name: reg.mainMembers[0]?.fullName || 'MPTM Member',
        amount: reg.registrationFee,
        date: reg.date,
      });
    }

    const don = await prisma.donation.findFirst({
      where: { publicToken, status: 'ACTIVE' },
    });

    if (don) {
      const expectedHmac = computeReceiptHmac(
        don.receiptNo,
        don.date,
        don.amountPaise || don.amount * 100,
        []
      );
      const valid = Boolean(don.receiptHmac && don.receiptHmac === expectedHmac);

      return res.json({
        success: true,
        valid,
        type: 'DONATION',
        receiptNo: don.receiptNo,
        name: don.name,
        amount: don.amount,
        date: don.date,
      });
    }

    return res.status(404).json({
      success: false,
      valid: false,
      error: 'Invalid or expired receipt token',
    });
  } catch (err) {
    safeErrorLog('VERIFY_ERROR', err);
    return res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

// ------------------------------------------------------------
// 8. GET /api/members/check-mobile/:mobileNo
// ------------------------------------------------------------
router.get('/members/check-mobile/:mobileNo', async (req, res) => {
  try {
    const mobileNo = String(req.params.mobileNo || '').trim();
    if (!/^[1-9]\d{9}$/.test(mobileNo)) {
      return res.status(400).json({ success: false, error: 'अवैध मोबाईल क्रमांक' });
    }

    const existing = await prisma.mainMember.findFirst({
      where: { mobileNo },
      select: { mobileNo: true, memberNo: true, fullName: true },
    });

    if (existing) {
      return res.json({
        success: true,
        exists: true,
        memberNo: existing.memberNo,
        mobileNo: existing.mobileNo,
        fullName: existing.fullName,
      });
    }

    return res.json({ success: true, exists: false });
  } catch (err) {
    safeErrorLog('CHECK_MOBILE_ERROR', err);
    return res.status(500).json({ success: false, error: 'Mobile check failed' });
  }
});

// Helper to resolve staff user context and scoping aliases
async function resolveStaffContext(req) {
  const email = String(req.query?.userEmail || req.headers?.['x-user-email'] || req.body?.userEmail || '').trim().toLowerCase();
  const role = String(req.query?.userRole || req.headers?.['x-user-role'] || req.body?.userRole || '').trim().toUpperCase();
  const isSuper =
    role === 'SUPER_ADMIN' ||
    role === 'ADMIN' ||
    email === 'mptmamravati.org' ||
    email === 'admin@mptmamravati.org' ||
    email === 'admin' ||
    email === 'superadmin' ||
    email === 'mptm_admin';

  if (isSuper) {
    return { isSuperAdmin: true, userEmail: email, refAliases: [] };
  }

  const refAliases = [];
  if (email) {
    refAliases.push(email);
    try {
      const staffUser = await prisma.managedUser.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
      });
      if (staffUser?.name && staffUser.name.trim()) {
        const nameClean = staffUser.name.trim().toLowerCase();
        if (!refAliases.includes(nameClean)) {
          refAliases.push(nameClean);
        }
      }
    } catch (e) {
      // ignore
    }
  } else {
    refAliases.push('__UNAUTHORIZED_NO_EMAIL__');
  }

  return {
    isSuperAdmin: false,
    userEmail: email,
    refAliases,
  };
}

// ------------------------------------------------------------
// 10. ADMIN: GET /api/admin/payments/summary
// ------------------------------------------------------------
router.get('/admin/payments/summary', async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { isSuperAdmin, refAliases } = await resolveStaffContext(req);

    if (!isSuperAdmin) {
      const regWhere = {
        OR: refAliases.map((a) => ({ referredBy: { equals: a, mode: 'insensitive' } })),
      };
      const todayRegWhere = {
        createdAt: { gte: todayStart },
        OR: refAliases.map((a) => ({ referredBy: { equals: a, mode: 'insensitive' } })),
      };

      const [regAgg, todayRegs, allFailed] = await Promise.all([
        prisma.memberRegistration.aggregate({
          where: regWhere,
          _count: { id: true },
          _sum: { registrationFee: true },
        }),
        prisma.memberRegistration.aggregate({
          where: todayRegWhere,
          _count: { id: true },
          _sum: { registrationFee: true },
        }),
        prisma.failedPayment.findMany({
          orderBy: { createdAt: 'desc' },
          take: 500,
        }),
      ]);

      const userFailed = allFailed.filter((f) => {
        const p = (typeof f.payload === 'object' && f.payload !== null) ? f.payload : {};
        const ref = String(p.referredBy || p.formData?.referredBy || '').trim().toLowerCase();
        return refAliases.includes(ref);
      });
      const todayUserFailed = userFailed.filter((f) => new Date(f.createdAt) >= todayStart);

      const totalSuccessCount = regAgg._count?.id || 0;
      const totalSuccessInr = regAgg._sum?.registrationFee || 0;
      const todaySuccessCount = todayRegs._count?.id || 0;
      const todaySuccessInr = todayRegs._sum?.registrationFee || 0;

      return res.json({
        success: true,
        data: {
          totalSuccessCount,
          totalSuccessInr,
          totalFailedCount: userFailed.length,
          todaySuccessCount,
          todaySuccessInr,
          todayFailedCount: todayUserFailed.length,
          totalRegistrations: regAgg._count?.id || 0,
          totalDonations: 0,
        },
      });
    }

    const [regAgg, donAgg, failedCount, todayRegs, todayDons, todayFailedCount] = await Promise.all([
      prisma.memberRegistration.aggregate({
        _count: { id: true },
        _sum: { registrationFee: true },
      }),
      prisma.donation.aggregate({
        _count: { id: true },
        _sum: { amount: true },
      }),
      prisma.failedPayment.count(),
      prisma.memberRegistration.aggregate({
        where: { createdAt: { gte: todayStart } },
        _count: { id: true },
        _sum: { registrationFee: true },
      }),
      prisma.donation.aggregate({
        where: { createdAt: { gte: todayStart } },
        _count: { id: true },
        _sum: { amount: true },
      }),
      prisma.failedPayment.count({
        where: { createdAt: { gte: todayStart } },
      }),
    ]);

    const totalSuccessCount = (regAgg._count?.id || 0) + (donAgg._count?.id || 0);
    const totalSuccessInr = (regAgg._sum?.registrationFee || 0) + (donAgg._sum?.amount || 0);

    const todaySuccessCount = (todayRegs._count?.id || 0) + (todayDons._count?.id || 0);
    const todaySuccessInr = (todayRegs._sum?.registrationFee || 0) + (todayDons._sum?.amount || 0);

    return res.json({
      success: true,
      data: {
        totalSuccessCount,
        totalSuccessInr,
        totalFailedCount: failedCount || 0,
        todaySuccessCount,
        todaySuccessInr,
        todayFailedCount: todayFailedCount || 0,
        totalRegistrations: regAgg._count?.id || 0,
        totalDonations: donAgg._count?.id || 0,
      },
    });
  } catch (err) {
    safeErrorLog('ADMIN_PAYMENTS_SUMMARY_ERROR', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch summary' });
  }
});

// ------------------------------------------------------------
// 11. ADMIN: GET /api/admin/payments/successful
// ------------------------------------------------------------
router.get('/admin/payments/successful', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().toLowerCase();
    const typeFilter = String(req.query.type || 'ALL').toUpperCase();
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '50'), 10)));

    const { isSuperAdmin, refAliases } = await resolveStaffContext(req);

    const regWhere = !isSuperAdmin
      ? { OR: refAliases.map((a) => ({ referredBy: { equals: a, mode: 'insensitive' } })) }
      : undefined;

    // Fetch registrations (scoped if staff member)
    const regs = await prisma.memberRegistration.findMany({
      where: regWhere,
      include: {
        mainMembers: { orderBy: { srNo: 'asc' } },
        familyMembers: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    // Fetch donations (Super Admin only; staff users only manage registrations)
    let dons = [];
    if (isSuperAdmin) {
      dons = await prisma.donation.findMany({
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
    }

    // Normalize registrations
    const regItems = regs.map((r) => {
      const isExec = (r.receiptNo || '').includes('EM-R') || (r.mainMembers?.[0]?.memberNo || '').includes('EM-S') || r.registrationFee >= 1000;
      const primaryMember = r.mainMembers?.[0];
      return {
        id: r.id,
        category: 'REGISTRATION',
        type: isExec ? 'EXECUTIVE' : 'PRIMARY',
        receiptNo: r.receiptNo,
        orderId: r.paymentReference || 'N/A',
        publicToken: r.publicToken,
        amount: r.registrationFee,
        amountInWords: r.amountInWords,
        name: primaryMember?.fullName || 'N/A',
        mobile: primaryMember?.mobileNo || 'N/A',
        memberCount: r.mainMembers?.length || 1,
        familyCount: r.familyMembers?.length || 0,
        mainMembers: r.mainMembers || [],
        familyMembers: r.familyMembers || [],
        address: r.address || '',
        gaav: r.gaav || '',
        taluka: r.taluka || '',
        city: r.city || '',
        district: r.district || '',
        state: r.state || '',
        country: r.country || '',
        pincode: r.pincode || '',
        referredBy: r.referredBy || null,
        paymentMode: r.paymentMode || 'PhonePe / UPI',
        date: r.date,
        createdAt: r.createdAt,
        receiptHmac: r.receiptHmac,
        hasValidHmac: Boolean(r.receiptHmac),
        status: r.status || 'ACTIVE',
      };
    });

    // Normalize donations
    const donItems = dons.map((d) => ({
      id: d.id,
      category: 'DONATION',
      type: 'DONATION',
      receiptNo: d.receiptNo,
      orderId: d.paymentReference || 'N/A',
      publicToken: d.publicToken,
      amount: d.amount,
      amountInWords: d.amountInWords,
      name: d.name,
      mobile: d.mobileNo,
      memberCount: 0,
      familyCount: 0,
      mainMembers: [],
      familyMembers: [],
      address: d.address || '',
      gaav: d.gaav || '',
      taluka: d.taluka || '',
      city: d.city || '',
      district: d.district || '',
      state: d.state || '',
      country: d.country || '',
      pincode: d.pincode || '',
      referredBy: null,
      paymentMode: d.paymentMode || 'PhonePe / UPI',
      date: d.date,
      createdAt: d.createdAt,
      receiptHmac: d.receiptHmac,
      hasValidHmac: Boolean(d.receiptHmac),
      status: d.status || 'ACTIVE',
    }));

    // Merge and sort
    let all = [...regItems, ...donItems].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    // Apply type filter
    if (typeFilter !== 'ALL') {
      all = all.filter((item) => item.type === typeFilter);
    }

    // Apply search filter
    if (search) {
      all = all.filter((item) => {
        const matchReceipt = (item.receiptNo || '').toLowerCase().includes(search);
        const matchOrder = (item.orderId || '').toLowerCase().includes(search);
        const matchName = (item.name || '').toLowerCase().includes(search);
        const matchMobile = (item.mobile || '').includes(search);
        const matchToken = (item.publicToken || '').toLowerCase().includes(search);
        const matchAnyMember = item.mainMembers?.some(
          (m) => (m.fullName || '').toLowerCase().includes(search) || (m.mobileNo || '').includes(search) || (m.memberNo || '').toLowerCase().includes(search)
        );
        return matchReceipt || matchOrder || matchName || matchMobile || matchToken || matchAnyMember;
      });
    }

    const total = all.length;
    const startIndex = (page - 1) * limit;
    const paginatedItems = all.slice(startIndex, startIndex + limit);

    return res.json({
      success: true,
      items: paginatedItems,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (err) {
    safeErrorLog('ADMIN_PAYMENTS_SUCCESSFUL_ERROR', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch successful payments' });
  }
});

// ------------------------------------------------------------
// 12. ADMIN: GET /api/admin/payments/failed
// ------------------------------------------------------------
router.get('/admin/payments/failed', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().toLowerCase();
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '50'), 10)));

    const { isSuperAdmin, refAliases } = await resolveStaffContext(req);

    // Query FailedPayments
    const failedList = await prisma.failedPayment.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    // Scope to staff user if not super admin
    const scopedFailedList = isSuperAdmin
      ? failedList
      : failedList.filter((f) => {
          const payload = (typeof f.payload === 'object' && f.payload !== null) ? f.payload : {};
          const ref = String(payload.referredBy || payload.formData?.referredBy || '').trim().toLowerCase();
          return refAliases.includes(ref);
        });

    // Fetch pending payments for merchant order IDs
    const pendingIds = scopedFailedList.map((f) => f.pendingPaymentId).filter(Boolean);
    const pendingPayments = await prisma.pendingPayment.findMany({
      where: { id: { in: pendingIds } },
      select: { id: true, merchantOrderId: true },
    });
    const pendingMap = new Map(pendingPayments.map((p) => [p.id, p.merchantOrderId]));

    let items = scopedFailedList.map((f) => {
      const payload = (typeof f.payload === 'object' && f.payload !== null) ? f.payload : {};
      let name = 'N/A';
      let mobile = 'N/A';
      const ref = payload.referredBy || payload.formData?.referredBy || null;

      if (f.type === 'DONATION') {
        name = payload.name || 'N/A';
        mobile = payload.mobileNo || 'N/A';
      } else {
        const firstMember = Array.isArray(payload.mainMembers) ? payload.mainMembers[0] : null;
        name = firstMember?.fullName || payload.fullName || 'N/A';
        mobile = firstMember?.mobileNo || payload.mobileNo || 'N/A';
      }

      return {
        id: f.id,
        pendingPaymentId: f.pendingPaymentId,
        orderId: pendingMap.get(f.pendingPaymentId) || 'N/A',
        type: f.type,
        amount: Math.round(Number(f.amountPaise || 0) / 100),
        name,
        mobile,
        referredBy: ref,
        provider: f.provider || 'phonepe',
        failureCode: f.failureCode || 'FAILED',
        failureReason: f.failureReason || 'Payment failed or cancelled by user',
        gatewayResponse: f.gatewayResponse,
        purgeAfter: f.purgeAfter,
        createdAt: f.createdAt,
        status: f.status || 'FAILED',
      };
    });

    if (search) {
      items = items.filter((f) => {
        const matchOrder = (f.orderId || '').toLowerCase().includes(search);
        const matchName = (f.name || '').toLowerCase().includes(search);
        const matchMobile = (f.mobile || '').includes(search);
        const matchReason = (f.failureReason || '').toLowerCase().includes(search);
        const matchCode = (f.failureCode || '').toLowerCase().includes(search);
        return matchOrder || matchName || matchMobile || matchReason || matchCode;
      });
    }

    const total = items.length;
    const startIndex = (page - 1) * limit;
    const paginatedItems = items.slice(startIndex, startIndex + limit);

    return res.json({
      success: true,
      items: paginatedItems,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (err) {
    safeErrorLog('ADMIN_PAYMENTS_FAILED_ERROR', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch failed payments' });
  }
});

// ------------------------------------------------------------
// 13. ADMIN: POST /api/admin/payments/verify-receipt
// ------------------------------------------------------------
router.post('/admin/payments/verify-receipt', async (req, res) => {
  try {
    const rawQuery = String(req.body.query || '').trim();
    if (!rawQuery) {
      return res.status(400).json({ success: false, error: 'पावती क्रमांक किंवा टोकन प्रविष्ट करा' });
    }

    const { isSuperAdmin, refAliases } = await resolveStaffContext(req);

    // Try MemberRegistration
    const reg = await prisma.memberRegistration.findFirst({
      where: {
        OR: [
          { receiptNo: { equals: rawQuery, mode: 'insensitive' } },
          { publicToken: rawQuery },
          { paymentReference: rawQuery },
        ],
      },
      include: {
        mainMembers: { orderBy: { srNo: 'asc' } },
        familyMembers: { orderBy: { srNo: 'asc' } },
      },
    });

    if (reg) {
      if (!isSuperAdmin) {
        const regRef = String(reg.referredBy || '').trim().toLowerCase();
        if (!refAliases.includes(regRef)) {
          return res.status(403).json({
            success: false,
            found: false,
            valid: false,
            error: 'तुम्हाला फक्त तुमच्या नोंदणीकृत सदस्यांच्या पावत्या पडताळण्याची परवानगी आहे. (Access restricted to your own registrations)',
          });
        }
      }

      const memberNos = reg.mainMembers.map((m) => m.memberNo);
      const expectedHmac = computeReceiptHmac(
        reg.receiptNo,
        reg.date,
        reg.amountPaise || reg.registrationFee * 100,
        memberNos
      );
      const isValid = Boolean(reg.receiptHmac && reg.receiptHmac === expectedHmac);

      return res.json({
        success: true,
        found: true,
        valid: isValid,
        category: 'REGISTRATION',
        type: reg.registrationFee >= 1000 ? 'EXECUTIVE' : 'PRIMARY',
        receiptNo: reg.receiptNo,
        date: reg.date,
        amount: reg.registrationFee,
        amountInWords: reg.amountInWords,
        name: reg.mainMembers?.[0]?.fullName || 'N/A',
        mobile: reg.mainMembers?.[0]?.mobileNo || 'N/A',
        members: reg.mainMembers,
        familyMembers: reg.familyMembers || [],
        familyCount: reg.familyMembers.length,
        referredBy: reg.referredBy,
        address: reg.address || '',
        gaav: reg.gaav || '',
        taluka: reg.taluka || '',
        city: reg.city || '',
        district: reg.district || '',
        state: reg.state || '',
        country: reg.country || '',
        pincode: reg.pincode || '',
        paymentMode: reg.paymentMode,
        paymentReference: reg.paymentReference,
        publicToken: reg.publicToken,
        storedHmac: reg.receiptHmac,
        computedHmac: expectedHmac,
        status: reg.status,
        verifiedAt: new Date().toISOString(),
      });
    }

    // Try Donation
    const don = await prisma.donation.findFirst({
      where: {
        OR: [
          { receiptNo: { equals: rawQuery, mode: 'insensitive' } },
          { publicToken: rawQuery },
          { paymentReference: rawQuery },
        ],
      },
    });

    if (don) {
      if (!isSuperAdmin) {
        return res.status(403).json({
          success: false,
          found: false,
          valid: false,
          error: 'देणगी पावती पडताळणी फक्त सुपर ॲडमिनसाठी उपलब्ध आहे. (Donation verification is restricted to Super Admin)',
        });
      }

      const expectedHmac = computeReceiptHmac(
        don.receiptNo,
        don.date,
        don.amountPaise || don.amount * 100,
        []
      );
      const isValid = Boolean(don.receiptHmac && don.receiptHmac === expectedHmac);

      return res.json({
        success: true,
        found: true,
        valid: isValid,
        category: 'DONATION',
        type: 'DONATION',
        receiptNo: don.receiptNo,
        date: don.date,
        amount: don.amount,
        amountInWords: don.amountInWords,
        name: don.name,
        mobile: don.mobileNo,
        members: [],
        familyMembers: [],
        familyCount: 0,
        address: don.address || '',
        gaav: don.gaav || '',
        taluka: don.taluka || '',
        city: don.city || '',
        district: don.district || '',
        state: don.state || '',
        country: don.country || '',
        pincode: don.pincode || '',
        paymentMode: don.paymentMode,
        paymentReference: don.paymentReference,
        publicToken: don.publicToken,
        storedHmac: don.receiptHmac,
        computedHmac: expectedHmac,
        status: don.status,
        verifiedAt: new Date().toISOString(),
      });
    }

    return res.json({
      success: true,
      found: false,
      valid: false,
      error: `पावती क्रमांक किंवा टोकन '${rawQuery}' सापडले नाही.`,
    });
  } catch (err) {
    safeErrorLog('ADMIN_VERIFY_RECEIPT_ERROR', err);
    return res.status(500).json({ success: false, error: 'Verification check failed' });
  }
});

module.exports = router;
