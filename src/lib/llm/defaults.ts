import { prisma } from '@/lib/prisma';

export const LLM_PURPOSES = [
  'CHAT',
  'REALTIME_SUMMARY',
  'FINAL_SUMMARY',
  'KEYWORD_EXTRACTION',
] as const;

export type LlmAdminPurpose = (typeof LLM_PURPOSES)[number];

type DefaultableModel = {
  id: string;
  purpose: string;
  isDefault: boolean;
};

export function pickDefaultModelIdsByPurpose(models: DefaultableModel[]) {
  const defaults: Partial<Record<LlmAdminPurpose, string>> = {};

  for (const model of models) {
    if (!model.isDefault) {
      continue;
    }

    const purpose = model.purpose as LlmAdminPurpose;
    if (!LLM_PURPOSES.includes(purpose)) {
      continue;
    }

    defaults[purpose] = model.id;
  }

  return defaults;
}

export async function normalizeDefaultModelsByPurpose(
  defaults: Partial<Record<LlmAdminPurpose, string>>
) {
  for (const purpose of LLM_PURPOSES) {
    const keepModelId = defaults[purpose];
    if (!keepModelId) {
      continue;
    }

    await prisma.llmModel.updateMany({
      where: {
        purpose,
        id: { not: keepModelId },
      },
      data: { isDefault: false },
    });

    await prisma.llmModel.update({
      where: { id: keepModelId },
      data: { isDefault: true },
    });
  }
}
