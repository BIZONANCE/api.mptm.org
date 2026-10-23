// ============================================================
// MPTM Dev Data Reset Script
// STRICT SAFETY GUARDS:
// 1. Refuses to run without --yes flag.
// 2. Refuses to run if NODE_ENV === 'production'.
// 3. Refuses to run unless PHONEPE_ENVIRONMENT === 'SANDBOX'.
// 4. Prints ONLY the DB host name, never credentials.
// 5. Does NOT touch Admin, ManagedUser, ExecutiveMember, CareerApplication,
//    ContactMessage, ContactInfo, or Advertisement.
// ============================================================
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();
function getDbHost(urlString) {
    try {
        const url = new URL(urlString);
        return url.host;
    }
    catch (e) {
        const match = String(urlString).match(/@([^/:?]+)/);
        return match ? match[1] : 'UNKNOWN_HOST';
    }
}
async function main() {
    const args = process.argv.slice(2);
    // Guard 1: Must pass --yes
    if (!args.includes('--yes')) {
        console.error('SAFETY ERROR: Refusing to reset data without explicit confirmation flag: --yes');
        console.error('Usage: node src/scripts/reset-dev-data.js --yes');
        process.exit(1);
    }
    // Guard 2: NODE_ENV cannot be production
    if (process.env.NODE_ENV === 'production') {
        console.error('SAFETY ERROR: Cannot run data reset when NODE_ENV=production!');
        process.exit(1);
    }
    // Guard 3: PHONEPE_ENVIRONMENT must be SANDBOX
    if (process.env.PHONEPE_ENVIRONMENT !== 'SANDBOX') {
        console.error('SAFETY ERROR: Cannot run data reset unless PHONEPE_ENVIRONMENT=SANDBOX!');
        process.exit(1);
    }
    const dbHost = getDbHost(process.env.DATABASE_URL);
    console.log('========================================================');
    console.log(`TARGET DATABASE HOST: ${dbHost}`);
    console.log('========================================================');
    const prisma = new PrismaClient();
    try {
        // 1. Query row counts about to be deleted
        const [regCount, mainMemberCount, familyMemberCount, donationCount, pendingCount, failedCount, webhookCount, auditCount, counterCount,] = await Promise.all([
            prisma.memberRegistration.count(),
            prisma.mainMember.count(),
            prisma.familyMember.count(),
            prisma.donation.count(),
            prisma.pendingPayment.count(),
            prisma.failedPayment.count(),
            prisma.webhookLog.count(),
            prisma.auditLog.count(),
            prisma.counter.count(),
        ]);
        console.log('Rows identified for reset:');
        console.log(`  - MemberRegistration: ${regCount}`);
        console.log(`  - MainMember:         ${mainMemberCount}`);
        console.log(`  - FamilyMember:       ${familyMemberCount}`);
        console.log(`  - Donation:           ${donationCount}`);
        console.log(`  - PendingPayment:     ${pendingCount}`);
        console.log(`  - FailedPayment:      ${failedCount}`);
        console.log(`  - WebhookLog:         ${webhookCount}`);
        console.log(`  - AuditLog:           ${auditCount}`);
        console.log(`  - Counter:            ${counterCount}`);
        console.log('\nExecuting reset in a single atomic transaction...');
        await prisma.$transaction(async (tx) => {
            // Delete in child-to-parent order
            await tx.familyMember.deleteMany();
            await tx.mainMember.deleteMany();
            await tx.memberRegistration.deleteMany();
            await tx.donation.deleteMany();
            await tx.failedPayment.deleteMany();
            await tx.pendingPayment.deleteMany();
            await tx.webhookLog.deleteMany();
            await tx.auditLog.deleteMany();
            // Reset counter sequences to 0
            await tx.counter.updateMany({
                data: { last: 0 },
            });
        });
        console.log('SUCCESS: Dev test data reset complete. Preserved tables: Admin, ManagedUser, ExecutiveMember, CareerApplication, ContactMessage, ContactInfo, Advertisement.');
    }
    finally {
        await prisma.$disconnect();
    }
}
main().catch((err) => {
    console.error('Reset failed:', err.message);
    process.exit(1);
});
