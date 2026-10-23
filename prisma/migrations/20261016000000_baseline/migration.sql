-- Baseline Migration for MPTM Database

-- CreateTable
CREATE TABLE IF NOT EXISTS "Admin" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Admin_username_key" ON "Admin"("username");

-- CreateTable
CREATE TABLE IF NOT EXISTS "MemberRegistration" (
    "id" TEXT NOT NULL,
    "receiptNo" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "registrationFee" INTEGER NOT NULL,
    "amountInWords" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "gaav" TEXT,
    "taluka" TEXT,
    "city" TEXT DEFAULT 'अमरावती',
    "district" TEXT DEFAULT 'अमरावती',
    "state" TEXT DEFAULT 'महाराष्ट्र',
    "country" TEXT DEFAULT 'भारत',
    "pincode" TEXT,
    "paymentMethod" TEXT NOT NULL,
    "paymentScreenshot" TEXT,
    "referredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MemberRegistration_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MemberRegistration_receiptNo_key" ON "MemberRegistration"("receiptNo");

-- CreateTable
CREATE TABLE IF NOT EXISTS "MainMember" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "srNo" INTEGER NOT NULL,
    "memberNo" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "mobileNo" TEXT NOT NULL,
    "prabhagNo" TEXT NOT NULL,
    CONSTRAINT "MainMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "FamilyMember" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "srNo" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "dob" TEXT NOT NULL,
    "occupation" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    CONSTRAINT "FamilyMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Donation" (
    "id" TEXT NOT NULL,
    "receiptNo" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mobileNo" TEXT NOT NULL,
    "address" TEXT,
    "gaav" TEXT,
    "taluka" TEXT,
    "city" TEXT DEFAULT 'अमरावती',
    "district" TEXT DEFAULT 'अमरावती',
    "state" TEXT DEFAULT 'महाराष्ट्र',
    "country" TEXT DEFAULT 'भारत',
    "pincode" TEXT,
    "amount" INTEGER NOT NULL,
    "amountInWords" TEXT NOT NULL,
    "paymentScreenshot" TEXT,
    "date" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Donation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Donation_receiptNo_key" ON "Donation"("receiptNo");

-- CreateTable
CREATE TABLE IF NOT EXISTS "ExecutiveMember" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "mobileNo" TEXT NOT NULL,
    "address" TEXT,
    "gaav" TEXT,
    "taluka" TEXT,
    "city" TEXT DEFAULT 'अमरावती',
    "district" TEXT DEFAULT 'अमरावती',
    "state" TEXT DEFAULT 'महाराष्ट्र',
    "country" TEXT DEFAULT 'भारत',
    "pincode" TEXT,
    "photoUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExecutiveMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CareerApplication" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "message" TEXT,
    "city" TEXT,
    "district" TEXT,
    "resumeName" TEXT,
    "resumeData" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CareerApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ContactMessage" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "subject" TEXT,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNREAD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ContactMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ContactInfo" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "address" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "alternatePhone" TEXT,
    "email" TEXT NOT NULL,
    "hours" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ContactInfo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Advertisement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "imageUrl" TEXT,
    "videoUrl" TEXT,
    "mediaType" TEXT DEFAULT 'image',
    "adLink" TEXT,
    "socialLinks" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Advertisement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ManagedUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "city" TEXT,
    "date" TEXT,
    "time" TEXT,
    "status" TEXT NOT NULL DEFAULT 'VERIFIED',
    "role" TEXT NOT NULL DEFAULT 'User',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ManagedUser_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ManagedUser_email_key" ON "ManagedUser"("email");

-- AddForeignKey
ALTER TABLE "MainMember" ADD CONSTRAINT "MainMember_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "MemberRegistration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyMember" ADD CONSTRAINT "FamilyMember_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "MemberRegistration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
