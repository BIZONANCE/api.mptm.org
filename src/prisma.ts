import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * Helper wrapper for database queries to handle Neon PostgreSQL auto-suspend connection drops (57P01).
 */
export async function withDbRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const errorMsg = String(error?.message || "");
    const isConnError =
      errorMsg.includes("57P01") ||
      errorMsg.includes("terminating connection") ||
      errorMsg.includes("Closed connection") ||
      errorMsg.includes("P1001") ||
      errorMsg.includes("P1017");

    if (isConnError && retries > 0) {
      console.warn("⚠️ Database connection idle dropped (Neon sleep recovery). Auto-reconnecting...");
      try {
        await prisma.$disconnect();
        await prisma.$connect();
      } catch (reconnErr) {
        // Continue to retry query
      }
      return withDbRetry(fn, retries - 1);
    }
    throw error;
  }
}