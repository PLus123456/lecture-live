-- Migrate thinkingMode 3 值 → 4 值：
--   OPTIONAL + supportsThinkingDepth=true  → DEPTH（Claude Extended Thinking / o-series 深度思考）
--   OPTIONAL + supportsThinkingDepth=false → AUTO（模型可自决，请求不带 thinking 参数）
--   FORCED   + supportsThinkingDepth=true  → DEPTH（既然支持深度，统一走 DEPTH，UI 仍可选 forced）
--   FORCED   + supportsThinkingDepth=false → 保持 FORCED（o1 类自带思考、不支持深度调节）
--   NONE                                   → 保持 NONE
UPDATE `LlmModel`
SET `thinkingMode` = CASE
  WHEN `thinkingMode` = 'OPTIONAL' AND `supportsThinkingDepth` = true  THEN 'DEPTH'
  WHEN `thinkingMode` = 'OPTIONAL' AND `supportsThinkingDepth` = false THEN 'AUTO'
  WHEN `thinkingMode` = 'FORCED'   AND `supportsThinkingDepth` = true  THEN 'DEPTH'
  ELSE `thinkingMode`
END;
