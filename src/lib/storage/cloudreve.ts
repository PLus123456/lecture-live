// src/lib/storage/cloudreve.ts

import path from 'path';
import { sanitizePath } from '@/lib/security';

const STORAGE_CATEGORIES = ['recordings', 'transcripts', 'summaries', 'reports'] as const;

interface CloudreveConfig {
  baseUrl: string;
  apiToken: string;
}

export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];

export function isStorageCategory(value: string): value is StorageCategory {
  return STORAGE_CATEGORIES.includes(value as StorageCategory);
}

export function isCloudreveConfigured(): boolean {
  return Boolean(
    process.env.CLOUDREVE_BASE_URL?.trim() &&
      process.env.CLOUDREVE_API_TOKEN?.trim()
  );
}

export function buildCloudreveRemotePath(
  userId: string,
  category: StorageCategory,
  fileName: string
): string {
  const safeName = sanitizePath(path.basename(fileName));
  const safeUserId = sanitizePath(userId);
  return `/${safeUserId}/${category}/${safeName}`;
}

function isPrivateIpv4Host(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return false;
  }

  const [first, second] = parts.map((part) => Number(part));
  if (first === 10 || first === 127) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  return first === 192 && second === 168;
}

function allowPrivateCloudreveHost(): boolean {
  const configured = process.env.CLOUDREVE_ALLOW_PRIVATE_HOST?.trim().toLowerCase();
  return configured === '1' || configured === 'true' || configured === 'yes';
}

function validateCloudreveBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('CLOUDREVE_BASE_URL must be a valid URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('CLOUDREVE_BASE_URL must use HTTPS');
  }

  const usesPrivateHost =
    parsed.username ||
    parsed.password ||
    parsed.hostname === 'localhost' ||
    parsed.hostname.endsWith('.local') ||
    parsed.hostname.endsWith('.internal') ||
    parsed.hostname === '::1' ||
    isPrivateIpv4Host(parsed.hostname);

  if (
    usesPrivateHost &&
    !allowPrivateCloudreveHost()
  ) {
    throw new Error('CLOUDREVE_BASE_URL must point to a trusted public host');
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function validateRemotePath(
  remotePath: string,
  expectedUserId?: string
): string {
  const parts = remotePath.split('/').filter(Boolean);
  if (parts.length !== 3) {
    throw new Error('Invalid Cloudreve remote path');
  }

  const [userId, category, fileName] = parts;
  if (sanitizePath(userId) !== userId) {
    throw new Error('Invalid Cloudreve user path');
  }

  if (expectedUserId && userId !== sanitizePath(expectedUserId)) {
    throw new Error('Cloudreve path does not belong to the current user');
  }

  if (!isStorageCategory(category)) {
    throw new Error('Invalid Cloudreve storage category');
  }

  if (sanitizePath(path.basename(fileName)) !== fileName) {
    throw new Error('Invalid Cloudreve file path');
  }

  return `/${userId}/${category}/${fileName}`;
}

export class CloudreveStorage {
  private config: CloudreveConfig;

  constructor() {
    if (!isCloudreveConfigured()) {
      throw new Error('Cloudreve is not configured');
    }

    this.config = {
      baseUrl: validateCloudreveBaseUrl(process.env.CLOUDREVE_BASE_URL!.trim()),
      apiToken: process.env.CLOUDREVE_API_TOKEN!.trim(),
    };
  }

  buildRemotePath(
    userId: string,
    category: StorageCategory,
    fileName: string
  ): string {
    return buildCloudreveRemotePath(userId, category, fileName);
  }

  /** 上传文件 */
  async upload(
    userId: string,
    category: StorageCategory,
    fileName: string,
    data: Buffer | string
  ): Promise<string> {
    const remotePath = this.buildRemotePath(userId, category, fileName);

    const response = await fetch(`${this.config.baseUrl}/api/v3/file/upload`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        'Content-Type': 'application/octet-stream',
        'X-Path': remotePath,
      },
      body:
        typeof data === 'string'
          ? new TextEncoder().encode(data)
          : new Uint8Array(data),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(
        `Cloudreve upload failed (${response.status}): ${errorText}`
      );
    }

    return remotePath;
  }

  /** 下载文件 */
  async download(
    userId: string,
    category: StorageCategory,
    fileName: string
  ): Promise<Buffer> {
    const remotePath = this.buildRemotePath(userId, category, fileName);
    return this.downloadByRemotePath(remotePath, userId);
  }

  async downloadByRemotePath(
    remotePath: string,
    expectedUserId?: string
  ): Promise<Buffer> {
    const safeRemotePath = validateRemotePath(remotePath, expectedUserId);
    const response = await fetch(`${this.config.baseUrl}/api/v3/file/download`, {
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        'X-Path': safeRemotePath,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(
        `Cloudreve download failed (${response.status}): ${errorText}`
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }
}
