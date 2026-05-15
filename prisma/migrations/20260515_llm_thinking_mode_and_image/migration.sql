-- LlmModel 新增三个字段：
--   thinkingMode           - 思考模式（NONE / OPTIONAL / FORCED）
--   supportsThinkingDepth  - 是否支持调节思考深度
--   supportsImage          - 是否支持图片输入
--
-- 之前的 thinkingDepth 字段保留，含义从「单一调用深度」改为「默认深度 + 不支持
-- 调节时的固定深度」。
ALTER TABLE `LlmModel`
  ADD COLUMN `thinkingMode` VARCHAR(191) NOT NULL DEFAULT 'NONE',
  ADD COLUMN `supportsThinkingDepth` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `supportsImage` BOOLEAN NOT NULL DEFAULT false;

-- 历史数据回填：现有 Anthropic 供应商下的模型默认有 Extended Thinking 能力，
-- 之前 gateway 是按 isAnthropic + thinkingDepth='high' 判断启用，现在迁到
-- thinkingMode=OPTIONAL + supportsThinkingDepth=true 的语义模型。
UPDATE `LlmModel` m
JOIN `LlmProvider` p ON p.id = m.providerId
SET m.thinkingMode = 'OPTIONAL',
    m.supportsThinkingDepth = true
WHERE p.isAnthropic = true;
