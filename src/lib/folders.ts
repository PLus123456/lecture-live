import { prisma } from '@/lib/prisma';
import { sanitizeTextInput } from '@/lib/security';

const MAX_FOLDER_NAME_LENGTH = 80;

type FolderRow = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: Date;
  _count: {
    sessions: number;
    keywordPool: number;
    children: number;
  };
};

export interface FolderListItem {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  sessionCount: number;
  keywordCount: number;
  childCount: number;
  depth: number;
  path: string[];
}

function sortRows(rows: FolderRow[]): FolderRow[] {
  return [...rows].sort((left, right) => {
    if (left.parentId === right.parentId) {
      return left.name.localeCompare(right.name, 'en', { sensitivity: 'base' });
    }
    return left.createdAt.getTime() - right.createdAt.getTime();
  });
}

export function buildFolderList(rows: FolderRow[]): FolderListItem[] {
  const sortedRows = sortRows(rows);
  const byId = new Map(sortedRows.map((row) => [row.id, row]));
  const childrenByParent = new Map<string | null, FolderRow[]>();

  for (const row of sortedRows) {
    const key = row.parentId && byId.has(row.parentId) ? row.parentId : null;
    const siblings = childrenByParent.get(key) ?? [];
    siblings.push(row);
    childrenByParent.set(key, siblings);
  }

  const flattened: FolderListItem[] = [];

  const visit = (parentId: string | null, depth: number, trail: string[]) => {
    const children = childrenByParent.get(parentId) ?? [];
    for (const child of children) {
      const path = [...trail, child.name];
      flattened.push({
        id: child.id,
        name: child.name,
        parentId: child.parentId,
        createdAt: child.createdAt.toISOString(),
        sessionCount: child._count.sessions,
        keywordCount: child._count.keywordPool,
        childCount: child._count.children,
        depth,
        path,
      });
      visit(child.id, depth + 1, path);
    }
  };

  visit(null, 0, []);
  return flattened;
}

export async function listFoldersForUser(userId: string): Promise<FolderListItem[]> {
  const rows = await prisma.folder.findMany({
    where: { userId },
    select: {
      id: true,
      name: true,
      parentId: true,
      createdAt: true,
      _count: {
        select: {
          sessions: true,
          keywordPool: true,
          children: true,
        },
      },
    },
  });

  return buildFolderList(rows);
}

export async function getOwnedFolder(folderId: string, userId: string) {
  return prisma.folder.findFirst({
    where: {
      id: folderId,
      userId,
    },
    select: {
      id: true,
      userId: true,
      name: true,
      parentId: true,
      createdAt: true,
      _count: {
        select: {
          sessions: true,
          keywordPool: true,
          children: true,
        },
      },
    },
  });
}

export function normalizeFolderName(value: unknown): string {
  const name = sanitizeTextInput(
    typeof value === 'string' ? value : '',
    { maxLength: MAX_FOLDER_NAME_LENGTH }
  );

  if (!name) {
    throw new Error('Folder name is required');
  }

  return name;
}

export function normalizeFolderId(value: unknown): string | null {
  const normalized = sanitizeTextInput(
    typeof value === 'string' ? value : '',
    { maxLength: 64 }
  );
  return normalized || null;
}

export async function ensureFolderParentOwnership(
  userId: string,
  parentId: string | null
) {
  if (!parentId) {
    return null;
  }

  const parent = await prisma.folder.findFirst({
    where: {
      id: parentId,
      userId,
    },
    select: {
      id: true,
      name: true,
      parentId: true,
    },
  });

  if (!parent) {
    throw new Error('Parent folder not found');
  }

  return parent;
}

export async function validateFolderMove(
  userId: string,
  folderId: string,
  nextParentId: string | null
) {
  if (!nextParentId) {
    return;
  }

  if (nextParentId === folderId) {
    throw new Error('Folder cannot be moved into itself');
  }

  const folders = await prisma.folder.findMany({
    where: { userId },
    select: {
      id: true,
      parentId: true,
    },
  });

  const byId = new Map(folders.map((folder) => [folder.id, folder.parentId]));
  if (!byId.has(nextParentId)) {
    throw new Error('Parent folder not found');
  }

  const visited = new Set<string>();
  let cursor: string | null = nextParentId;
  while (cursor) {
    if (cursor === folderId) {
      throw new Error('Folder cannot be moved into one of its descendants');
    }
    if (visited.has(cursor)) {
      break;
    }
    visited.add(cursor);
    cursor = byId.get(cursor) ?? null;
  }
}
