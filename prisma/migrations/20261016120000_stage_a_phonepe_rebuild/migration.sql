-- Stage A + PhonePe Rebuild Migration

-- 1. Counter table
CREATE TABLE IF NOT EXISTS "Counter" (
    "key" TEXT NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Counter_pkey" PRIMARY KEY ("key")
);

-- 2. PendingPayment table
CREATE TABLE IF NOT EXISTS "PendingPayment" (
    "id" TEXT NOT NULL,
    "merchantOrderId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL DEFAULT 'phonepe',
    "gatewayTxnId" TEXT,
    "gatewayResponse" JSONB,
    "publicToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "PendingPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PendingPayment_merchantOrderId_key" ON "PendingPayment"("merchantOrderId");
CREATE UNIQUE INDEX IF NOT EXISTS "PendingPayment_idempotencyKey_key" ON "PendingPayment"("idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "PendingPayment_publicToken_key" ON "PendingPayment"("publicToken");
CREATE INDEX IF NOT EXISTS "PendingPayment_status_idx" ON "PendingPayment"("status");
CREATE INDEX IF NOT EXISTS "PendingPayment_createdAt_idx" ON "PendingPayment"("createdAt");

-- 3. FailedPayment table
CREATE TABLE IF NOT EXISTS "FailedPayment" (
    "id" TEXT NOT NULL,
    "pendingPaymentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "gatewayResponse" JSONB,
    "failureCode" TEXT,
    "failureReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'FAILED',
    "purgeAfter" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FailedPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "FailedPayment_pendingPaymentId_key" ON "FailedPayment"("pendingPaymentId");

-- 4. WebhookLog table
CREATE TABLE IF NOT EXISTS "WebhookLog" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT,
    "rawBody" TEXT NOT NULL,
    "signatureValid" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookLog_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WebhookLog_eventId_key" ON "WebhookLog"("eventId");

-- 5. AuditLog table
CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- 6. MemberRegistration additions
ALTER TABLE "MemberRegistration"
    ADD COLUMN IF NOT EXISTS "pendingPaymentId" TEXT,
    ADD COLUMN IF NOT EXISTS "publicToken" TEXT,
    ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN IF NOT EXISTS "paymentMode" TEXT,
    ADD COLUMN IF NOT EXISTS "paymentReference" TEXT,
    ADD COLUMN IF NOT EXISTS "amountPaise" INTEGER,
    ADD COLUMN IF NOT EXISTS "collectedBy" TEXT,
    ADD COLUMN IF NOT EXISTS "receiptHmac" TEXT,
    ADD COLUMN IF NOT EXISTS "paymentDetails" JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS "MemberRegistration_pendingPaymentId_key" ON "MemberRegistration"("pendingPaymentId");
CREATE UNIQUE INDEX IF NOT EXISTS "MemberRegistration_publicToken_key" ON "MemberRegistration"("publicToken");

ALTER TABLE "MemberRegistration"
    ADD CONSTRAINT "MemberRegistration_pendingPaymentId_fkey"
    FOREIGN KEY ("pendingPaymentId") REFERENCES "PendingPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 7. Donation additions
ALTER TABLE "Donation"
    ADD COLUMN IF NOT EXISTS "pendingPaymentId" TEXT,
    ADD COLUMN IF NOT EXISTS "publicToken" TEXT,
    ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN IF NOT EXISTS "paymentMode" TEXT,
    ADD COLUMN IF NOT EXISTS "paymentReference" TEXT,
    ADD COLUMN IF NOT EXISTS "amountPaise" INTEGER,
    ADD COLUMN IF NOT EXISTS "collectedBy" TEXT,
    ADD COLUMN IF NOT EXISTS "receiptHmac" TEXT,
    ADD COLUMN IF NOT EXISTS "paymentDetails" JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS "Donation_pendingPaymentId_key" ON "Donation"("pendingPaymentId");
CREATE UNIQUE INDEX IF NOT EXISTS "Donation_publicToken_key" ON "Donation"("publicToken");

ALTER TABLE "Donation"
    ADD CONSTRAINT "Donation_pendingPaymentId_fkey"
    FOREIGN KEY ("pendingPaymentId") REFERENCES "PendingPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 8. MainMember additions
ALTER TABLE "MainMember"
    ADD COLUMN IF NOT EXISTS "memberNoSeq" INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS "MainMember_memberNo_key" ON "MainMember"("memberNo");
CREATE INDEX IF NOT EXISTS "MainMember_mobileNo_idx" ON "MainMember"("mobileNo");
