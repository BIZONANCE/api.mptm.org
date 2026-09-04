"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
exports.withDbRetry = withDbRetry;
const client_1 = require("@prisma/client");
const globalForPrisma = globalThis;
exports.prisma = globalForPrisma.prisma ??
    new client_1.PrismaClient({
        log: ["error"],
    });
if (process.env.NODE_ENV !== "production")
    globalForPrisma.prisma = exports.prisma;
/**
 * Helper wrapper for database queries to handle Neon PostgreSQL auto-suspend connection drops (57P01).
 */
async function withDbRetry(fn, retries = 2) {
    try {
        return await fn();
    }
    catch (error) {
        const errorMsg = String(error?.message || "");
        const isConnError = errorMsg.includes("57P01") ||
            errorMsg.includes("terminating connection") ||
            errorMsg.includes("Closed connection") ||
            errorMsg.includes("P1001") ||
            errorMsg.includes("P1017");
        if (isConnError && retries > 0) {
            console.warn("⚠️ Database connection idle dropped (Neon sleep recovery). Auto-reconnecting...");
            try {
                await exports.prisma.$disconnect();
                await exports.prisma.$connect();
            }
            catch (reconnErr) {
                // Continue to retry query
            }
            return withDbRetry(fn, retries - 1);
        }
        throw error;
    }
}
