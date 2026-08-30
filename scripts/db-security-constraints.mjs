// Runtime-installed database constraints that Prisma `db push` cannot express.
// Keep this module side-effect free so its version gates and SQL ordering can be unit tested.

export const RECHARGE_TIER_ADMIN_CONSTRAINT =
  'RechargeTier_no_active_admin_grant_chk';

export const SQL_QUARANTINE_ACTIVE_ADMIN_TIERS = `
  UPDATE \`RechargeTier\`
  SET \`active\` = FALSE
  WHERE \`kind\` = 'membership'
    AND \`grantRole\` = 'ADMIN'
    AND \`active\` = TRUE
`;

export const SQL_ADD_RECHARGE_TIER_ADMIN_CONSTRAINT = `
  ALTER TABLE \`RechargeTier\`
    ADD CONSTRAINT \`${RECHARGE_TIER_ADMIN_CONSTRAINT}\`
    CHECK (
      NOT (
        \`kind\` = 'membership'
        AND \`grantRole\` = 'ADMIN'
        AND \`active\` = TRUE
      )
    )
`;

export const SQL_ENFORCE_RECHARGE_TIER_ADMIN_CONSTRAINT = `
  ALTER TABLE \`RechargeTier\`
    ALTER CHECK \`${RECHARGE_TIER_ADMIN_CONSTRAINT}\` ENFORCED
`;

function atLeast(actual, required) {
  for (let i = 0; i < required.length; i += 1) {
    if (actual[i] > required[i]) return true;
    if (actual[i] < required[i]) return false;
  }
  return true;
}

/**
 * MySQL parsed but ignored CHECK constraints before 8.0.16. MariaDB has enforced
 * them since 10.2.1. Unknown/forked version strings deliberately fail closed:
 * installing a decorative, unenforced constraint would be worse than refusing startup.
 */
export function supportsEnforcedCheckConstraints(rawVersion) {
  const version = String(rawVersion ?? '');
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  if (version.toLowerCase().includes('mariadb')) {
    return atLeast(actual, [10, 2, 1]);
  }
  // Known forks that report a MySQL-compatible version must be explicitly assessed,
  // rather than assumed to enforce MySQL CHECK semantics.
  if (/(tidb|vitess|singlestore)/i.test(version)) return false;
  return atLeast(actual, [8, 0, 16]);
}

async function tableExists(prisma, table) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'`
  );
  return Number(rows[0]?.cnt ?? 0) > 0;
}

async function constraintExists(prisma, table, constraint) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = '${table}'
       AND CONSTRAINT_NAME = '${constraint}'
       AND CONSTRAINT_TYPE = 'CHECK'`
  );
  return Number(rows[0]?.cnt ?? 0) > 0;
}

async function constraintIsEnforced(prisma, table, constraint, version) {
  // MariaDB does not expose MySQL's TABLE_CONSTRAINTS.ENFORCED column. On the
  // supported MariaDB range CHECK is enforced by default; MySQL exposes the
  // exact state, so reject/repair a pre-existing NOT ENFORCED constraint.
  if (String(version).toLowerCase().includes('mariadb')) return true;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ENFORCED AS enforced FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = '${table}'
       AND CONSTRAINT_NAME = '${constraint}'
       AND CONSTRAINT_TYPE = 'CHECK'`
  );
  return String(rows[0]?.enforced ?? '').toUpperCase() === 'YES';
}

async function databaseVersion(prisma) {
  const rows = await prisma.$queryRawUnsafe('SELECT VERSION() AS version');
  return String(rows[0]?.version ?? '');
}

/**
 * SEC-023 database boundary.
 *
 * Order matters: quarantine legacy active rows first, then add the CHECK. Inactive
 * ADMIN rows remain as incident/audit evidence. The constraint installation is safe
 * under repeated and concurrent application starts: it probes first and, if another
 * process wins the ALTER race, re-probes before deciding whether to fail.
 *
 * @param {any} prisma
 * @param {{ log: (...args: any[]) => void, warn: (...args: any[]) => void }} logger
 */
export async function ensureRechargeTierAdminConstraint(prisma, logger = console) {
  const table = 'RechargeTier';
  if (!(await tableExists(prisma, table))) {
    logger.log(
      '[migrate-data] RechargeTier 不存在（全新库），安全约束将在 db push 后安装'
    );
    return { status: 'table_missing' };
  }

  const version = await databaseVersion(prisma);
  if (!supportsEnforcedCheckConstraints(version)) {
    throw new Error(
      `SEC-023 requires enforced CHECK constraints (MySQL >= 8.0.16 or MariaDB >= 10.2.1); ` +
        `database reports ${version || 'an unknown version'}`
    );
  }

  const quarantined = await prisma.$executeRawUnsafe(
    SQL_QUARANTINE_ACTIVE_ADMIN_TIERS
  );
  if (Number(quarantined) > 0) {
    logger.warn(
      `[migrate-data] SEC-023：已停用 ${Number(quarantined)} 个历史 ADMIN 会员商品（保留记录供审计）`
    );
  }

  if (await constraintExists(prisma, table, RECHARGE_TIER_ADMIN_CONSTRAINT)) {
    if (
      !(await constraintIsEnforced(
        prisma,
        table,
        RECHARGE_TIER_ADMIN_CONSTRAINT,
        version
      ))
    ) {
      await prisma.$executeRawUnsafe(SQL_ENFORCE_RECHARGE_TIER_ADMIN_CONSTRAINT);
      if (
        !(await constraintIsEnforced(
          prisma,
          table,
          RECHARGE_TIER_ADMIN_CONSTRAINT,
          version
        ))
      ) {
        throw new Error(
          `SEC-023 database constraint ${RECHARGE_TIER_ADMIN_CONSTRAINT} is not enforced`
        );
      }
      logger.warn('[migrate-data] SEC-023：已重新启用被标记为 NOT ENFORCED 的约束');
      return { status: 'enforced_existing', quarantined: Number(quarantined) };
    }
    logger.log('[migrate-data] SEC-023：RechargeTier ADMIN 商品约束已存在，跳过');
    return { status: 'already_present', quarantined: Number(quarantined) };
  }

  try {
    await prisma.$executeRawUnsafe(SQL_ADD_RECHARGE_TIER_ADMIN_CONSTRAINT);
  } catch (error) {
    // Two app replicas may run ensure-database concurrently. Only swallow the ALTER
    // error when the other replica demonstrably installed our named CHECK constraint.
    if (
      (await constraintExists(prisma, table, RECHARGE_TIER_ADMIN_CONSTRAINT)) &&
      (await constraintIsEnforced(
        prisma,
        table,
        RECHARGE_TIER_ADMIN_CONSTRAINT,
        version
      ))
    ) {
      logger.log('[migrate-data] SEC-023：约束已由另一启动进程并发安装');
      return { status: 'installed_concurrently', quarantined: Number(quarantined) };
    }
    throw error;
  }

  if (!(await constraintExists(prisma, table, RECHARGE_TIER_ADMIN_CONSTRAINT))) {
    throw new Error(
      `SEC-023 database constraint ${RECHARGE_TIER_ADMIN_CONSTRAINT} was not installed`
    );
  }
  if (
    !(await constraintIsEnforced(
      prisma,
      table,
      RECHARGE_TIER_ADMIN_CONSTRAINT,
      version
    ))
  ) {
    throw new Error(
      `SEC-023 database constraint ${RECHARGE_TIER_ADMIN_CONSTRAINT} is not enforced`
    );
  }
  logger.log('[migrate-data] SEC-023：已安装 RechargeTier ADMIN 商品约束');
  return { status: 'installed', quarantined: Number(quarantined) };
}
