import { schema, type Db } from "@datahub/db";

const { users, authUser, account } = schema;

export interface BackfillResult {
  users: number;
  accounts: number;
}

/**
 * Backfill Better Auth identities from the existing `users` table (design D3).
 *
 * For each legacy user we create:
 *  - an `auth_user` row with the SAME id (so `user_companies` / `folders` still
 *    line up by value) plus the business fields (role / companyId / status);
 *  - a `credential` `account` row carrying the existing bcrypt `password_hash`
 *    verbatim — so users authenticate with no forced reset.
 *
 * Idempotent (primary-key conflicts are ignored), so it is safe to re-run, and
 * reversible by dropping the Better Auth tables (0000_better_auth_identity.down.sql).
 */
export async function backfillBetterAuthIdentities(db: Db): Promise<BackfillResult> {
  const rows = await db.select().from(users);
  let userCount = 0;
  let accountCount = 0;

  for (const row of rows) {
    await db
      .insert(authUser)
      .values({
        id: row.id,
        name: row.name,
        email: row.email,
        emailVerified: true, // migrated accounts are considered verified
        role: row.role,
        companyId: row.companyId,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })
      .onConflictDoNothing();
    userCount += 1;

    await db
      .insert(account)
      .values({
        id: `cred_${row.id}`,
        accountId: row.id,
        providerId: "credential",
        userId: row.id,
        password: row.passwordHash,
      })
      .onConflictDoNothing();
    accountCount += 1;
  }

  return { users: userCount, accounts: accountCount };
}
