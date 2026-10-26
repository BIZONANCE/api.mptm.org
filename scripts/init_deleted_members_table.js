const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    console.log("Checking / creating DeletedMember table in PostgreSQL...");
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "DeletedMember" (
        "id" TEXT NOT NULL,
        "memberType" TEXT NOT NULL,
        "originalId" TEXT,
        "receiptNo" TEXT,
        "memberNo" TEXT,
        "fullName" TEXT NOT NULL,
        "designation" TEXT,
        "mobileNo" TEXT NOT NULL,
        "email" TEXT,
        "address" TEXT,
        "gaav" TEXT,
        "taluka" TEXT,
        "city" TEXT DEFAULT 'अमरावती',
        "district" TEXT DEFAULT 'अमरावती',
        "state" TEXT DEFAULT 'महाराष्ट्र',
        "country" TEXT DEFAULT 'भारत',
        "pincode" TEXT,
        "photoUrl" TEXT,
        "registrationFee" INTEGER,
        "paymentMethod" TEXT,
        "paymentReference" TEXT,
        "referredBy" TEXT,
        "registrationDate" TEXT,
        "familyMembers" JSONB,
        "fullData" JSONB,
        "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "deletedBy" TEXT,
        "reason" TEXT,
        CONSTRAINT "DeletedMember_pkey" PRIMARY KEY ("id")
      );
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "DeletedMember_memberType_idx" ON "DeletedMember"("memberType");
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "DeletedMember_deletedAt_idx" ON "DeletedMember"("deletedAt");
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "DeletedMember_mobileNo_idx" ON "DeletedMember"("mobileNo");
    `);

    console.log("✅ DeletedMember table and indices verified/created successfully!");
  } catch (err) {
    console.error("❌ Error initializing DeletedMember table:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
