// src/types/report.ts
// 会话报告类型定义 — 录音结束后自动生成的结构化会议报告

/** 意义评估结果 */
export interface SignificanceEvaluation {
  /** 0-1 分数，表示该录音内容是否有意义 */
  score: number;
  /** 评估理由 */
  reason: string;
  /** 是否值得生成报告 */
  isWorthSummarizing: boolean;
}

/** 报告中的内容分节 */
export interface ReportSection {
  /** 分节标题 */
  title: string;
  /** 该节讨论的要点 */
  points: string[];
}

/** 结构化会议报告 */
export interface SessionReport {
  /** 报告标题/主题 */
  title: string;
  /** 录音内容的核心主题 */
  topic: string;
  /** 识别出的参与人/说话人 */
  participants: string[];
  /** 录制日期 */
  date: string;
  /** 录制时长（人类可读格式） */
  duration: string;
  /** 内容概要（1-3句话） */
  overview: string;
  /** 分节内容 */
  sections: ReportSection[];
  /** 关键结论 */
  conclusions: string[];
  /** 待办事项/后续行动（如果有） */
  actionItems: string[];
  /** 关键术语及定义 */
  keyTerms: Record<string, string>;
}

/** 完整报告数据（包含意义评估 + 报告内容） */
export interface SessionReportData {
  /** 意义评估 */
  significance: SignificanceEvaluation;
  /** 会议报告（仅当 significance.isWorthSummarizing 为 true 时存在） */
  report: SessionReport | null;
  /** 报告生成时间 */
  generatedAt: string;
}
