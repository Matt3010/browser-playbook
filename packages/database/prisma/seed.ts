import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@app/shared";

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.SEED_USER_EMAIL ?? "test@example.com").toLowerCase();
  const password = process.env.SEED_USER_PASSWORD ?? "TestPassword123!";

  // Idempotent: re-running the seed refreshes the password without duplicating
  // the user, so a re-seeded test environment always has known credentials.
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, passwordHash: await hashPassword(password) },
    update: { passwordHash: await hashPassword(password) }
  });

  console.log(`Seeded user ${user.email} (${user.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
