import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const isDevelopment = process.env.NODE_ENV === 'development';

function createPrismaClient() {
  return new PrismaClient({
    log: isDevelopment ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
