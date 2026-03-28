/**
 * 统一的语言列表配置
 * 所有语言选择器共用，避免重复定义
 */

export interface LanguageOption {
  /** 语言代码（ISO 639-1） */
  code: string;
  /** 语言名称（原文 / 本地语言） */
  name: string;
  /** 英文标签（用于设置页面等场景） */
  label: string;
}

export const LANGUAGES: LanguageOption[] = [
  { code: 'en', name: 'English', label: 'English' },
  { code: 'zh', name: '中文', label: 'Chinese' },
  { code: 'ja', name: '日本語', label: 'Japanese' },
  { code: 'ko', name: '한국어', label: 'Korean' },
  { code: 'fr', name: 'Français', label: 'French' },
  { code: 'de', name: 'Deutsch', label: 'German' },
  { code: 'es', name: 'Español', label: 'Spanish' },
  { code: 'pt', name: 'Português', label: 'Portuguese' },
  { code: 'it', name: 'Italiano', label: 'Italian' },
  { code: 'ru', name: 'Русский', label: 'Russian' },
  { code: 'ar', name: 'العربية', label: 'Arabic' },
  { code: 'hi', name: 'हिन्दी', label: 'Hindi' },
  { code: 'th', name: 'ไทย', label: 'Thai' },
  { code: 'vi', name: 'Tiếng Việt', label: 'Vietnamese' },
  { code: 'id', name: 'Indonesia', label: 'Indonesian' },
  { code: 'tr', name: 'Türkçe', label: 'Turkish' },
  { code: 'pl', name: 'Polski', label: 'Polish' },
  { code: 'nl', name: 'Nederlands', label: 'Dutch' },
  { code: 'sv', name: 'Svenska', label: 'Swedish' },
  { code: 'da', name: 'Dansk', label: 'Danish' },
  { code: 'fi', name: 'Suomi', label: 'Finnish' },
  { code: 'no', name: 'Norsk', label: 'Norwegian' },
  { code: 'uk', name: 'Українська', label: 'Ukrainian' },
  { code: 'cs', name: 'Čeština', label: 'Czech' },
  { code: 'ro', name: 'Română', label: 'Romanian' },
  { code: 'hu', name: 'Magyar', label: 'Hungarian' },
  { code: 'el', name: 'Ελληνικά', label: 'Greek' },
  { code: 'bg', name: 'Български', label: 'Bulgarian' },
  { code: 'he', name: 'עברית', label: 'Hebrew' },
  { code: 'ms', name: 'Melayu', label: 'Malay' },
  { code: 'tl', name: 'Filipino', label: 'Filipino' },
];
