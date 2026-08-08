// src/lib/storage/migration.ts
// 存储迁移：本地 → Cloudreve 上传迁移 + 本地文件过期清理

import fs from 'fs/promises';
import path from 'path';
import { prisma } from '@/lib/prisma';
import { assertWithinRoot } from '@/lib/security';
import {
  CloudreveStorage,
  isCloudreveConfiguredAsync,
  type SessionArtifactCategory,
} from '@/lib/storage/cloudreve';

const DATA_ROOT = path.join(process.cwd(), 'data');
const CATEGORIES: SessionArtifactCategory[] = ['recordings', 'transcripts', 'summaries', 'reports', 'full-transcripts'];

const PATH_FIELDS = {
  recordings: 'recordingPath',
  transcripts: 'transcriptPath',
  summaries: 'summaryPath',
  reports: 'reportPath',
  'full-transcripts': 'fullTranscriptPath',
} as const;

export interface MigrationResult {
  migratedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: string[];
}

export interface CleanupResult {
  deletedCount: number;
  errorCount: number;
  errors: string[];
}

/**
 * 解析 local: 引用，返回本地文件绝对路径。
 *
 * Y8/P6-6：remainder 直接来自 DB 的 path 列，裸 path.join 会让 `local:../../etc/passwd`
 * 被读出来上传到 Cloudreve（迁移是把文件整个读走再上传的）。越界一律返回 null，
 * 调用方按「文件不存在」跳过。
 */
function resolveLocalPath(reference: string): string | null {
  if (!reference.startsWith('local:')) return null;
  const remainder = reference.slice('local:'.length);
  if (!remainder) return null;
  // local:recordings/xxx.webm → data/recordings/xxx.webm
  const fullPath = path.join(DATA_ROOT, remainder);
  try {
    assertWithinRoot(fullPath, DATA_ROOT);
  } catch {
    return null;
  }
  return fullPath;
}

/**
 * 判断一个 path 引用是否是本地引用（尚未上传到 Cloudreve）
 */
function isLocalOnlyReference(ref: string | null | undefined): boolean {
  if (!ref) return false;
  return ref.startsWith('local:');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 将所有仅存在于本地的文件迁移上传到 Cloudreve，并更新数据库引用
 */
export async function migrateLocalToCloudreve(): Promise<MigrationResult> {
  if (!(await isCloudreveConfiguredAsync())) {
    return { migratedCount: 0, skippedCount: 0, errorCount: 0, errors: ['Cloudreve 未配置'] };
  }

  const storage = await CloudreveStorage.create();
  const result: MigrationResult = {
    migratedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    errors: [],
  };

  // 查找所有有本地引用的 session
  const sessions = await prisma.session.findMany({
    where: {
      OR: [
        { recordingPath: { startsWith: 'local:' } },
        { transcriptPath: { startsWith: 'local:' } },
        { summaryPath: { startsWith: 'local:' } },
        { reportPath: { startsWith: 'local:' } },
        { fullTranscriptPath: { startsWith: 'local:' } },
      ],
    },
    select: {
      id: true,
      userId: true,
      recordingPath: true,
      transcriptPath: true,
      summaryPath: true,
      reportPath: true,
      fullTranscriptPath: true,
    },
  });

  for (const session of sessions) {
    for (const category of CATEGORIES) {
      const field = PATH_FIELDS[category];
      const ref = session[field];

      if (!isLocalOnlyReference(ref)) {
        result.skippedCount++;
        continue;
      }

      const localPath = resolveLocalPath(ref!);
      if (!localPath || !(await fileExists(localPath))) {
        result.skippedCount++;
        continue;
      }

      try {
        const data = await fs.readFile(localPath);
        const fileName = path.basename(localPath);
        const remotePath = await storage.upload(session.userId, category, fileName, data);

        // 更新数据库引用为 Cloudreve 路径
        await prisma.session.update({
          where: { id: session.id },
          data: { [field]: remotePath },
        });

        result.migratedCount++;
      } catch (err) {
        result.errorCount++;
        result.errors.push(
          `session=${session.id} category=${category}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  return result;
}

/**
 * 清理超过保留天数的本地文件（仅在 Cloudreve 模式下执行）
 * 只清理已经成功上传到 Cloudreve 的文件（引用以 / 开头）
 */
export async function cleanupExpiredLocalFiles(
  retentionDays: number
): Promise<CleanupResult> {
  const result: CleanupResult = { deletedCount: 0, errorCount: 0, errors: [] };

  if (retentionDays <= 0) {
    return result; // 0 = 永久保留，不清理
  }

  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  // 只清理已上传到 Cloudreve 的 session（引用以 / 开头表示已在 Cloudreve）
  // 且更新时间早于截止日期
  const sessions = await prisma.session.findMany({
    where: {
      updatedAt: { lt: cutoffDate },
      OR: [
        { recordingPath: { startsWith: '/' } },
        { transcriptPath: { startsWith: '/' } },
        { summaryPath: { startsWith: '/' } },
        { reportPath: { startsWith: '/' } },
        { fullTranscriptPath: { startsWith: '/' } },
      ],
    },
    select: {
      id: true,
      recordingPath: true,
      transcriptPath: true,
      summaryPath: true,
      reportPath: true,
      fullTranscriptPath: true,
    },
  });

  for (const session of sessions) {
    for (const category of CATEGORIES) {
      const field = PATH_FIELDS[category];
      const ref = session[field];

      // 只有 Cloudreve 引用的 session 才清理其对应的本地文件
      if (!ref || !ref.startsWith('/')) continue;

      // 从 Cloudreve 路径推导出本地文件名：/{userId}/{category}/{fileName} → data/{category}/{fileName}
      const parts = ref.split('/').filter(Boolean);
      if (parts.length !== 3) continue;
      const [, , fileName] = parts;

      // Y8/P6-6：fileName 同样来自 DB，单个路径段仍可能是 `..`（→ 拼出 data/ 本身）。
      // 这里要求落在 data/<category>/ 内——unlink 的目标只该是那一层里的文件。
      const categoryRoot = path.join(DATA_ROOT, category);
      const localPath = path.join(categoryRoot, fileName);
      try {
        assertWithinRoot(localPath, categoryRoot);
      } catch {
        result.errorCount++;
        result.errors.push(`${ref}: 引用越界，已跳过`);
        continue;
      }
      if (!(await fileExists(localPath))) continue;

      try {
        await fs.unlink(localPath);
        result.deletedCount++;
      } catch (err) {
        result.errorCount++;
        result.errors.push(
          `${localPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  return result;
}
