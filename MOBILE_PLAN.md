# LectureLive 手机端适配方案

## 总体策略

在现有 Next.js 代码库内做响应式改造 —— 同一套代码、同一套 API、同一套 hooks/stores，UI 组件根据屏幕尺寸切换布局。不新建独立项目。

**断点定义**: `md (768px)` 为分界，< 768px 为手机端布局，≥ 768px 保持现有桌面布局不变。

**原则**:
- 所有现有桌面端组件和逻辑**保持不变**，仅在手机端条件下替换布局
- 手机端专用组件放在 `src/components/mobile/` 目录
- 通过 `useIsMobile()` hook 在页面级切换布局，而非在每个子组件内判断
- 100% 功能覆盖，不裁剪任何桌面端功能

---

## 一、基础设施

### 1.1 新建 `src/hooks/useIsMobile.ts`

```typescript
'use client';

import { useState, useEffect } from 'react';

const MOBILE_BREAKPOINT = 768;

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const handler = (e: MediaQueryListEvent | MediaQueryList) => setIsMobile(e.matches);
    handler(mql);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isMobile;
}
```

- SSR 时默认 `false`（桌面），hydration 后立即更新
- 使用 `matchMedia` 而非 `resize` 事件，性能更好

### 1.2 PWA 配置

**新建 `src/app/manifest.json`（Next.js App Router 约定路径）**:

```json
{
  "name": "LectureLive",
  "short_name": "LectureLive",
  "description": "实时课堂转写与智能笔记",
  "start_url": "/home",
  "display": "standalone",
  "background_color": "#FAF8F5",
  "theme_color": "#C75B3A",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

**修改 `src/app/layout.tsx`**，在 `<head>` 内添加:

```html
<link rel="manifest" href="/manifest.json" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
```

> `maximum-scale=1` 防止 iOS 输入框聚焦时自动缩放（前提是所有输入框字号 ≥ 16px）。
> `viewport-fit=cover` 配合 `env(safe-area-inset-*)` 适配刘海屏。

### 1.3 全局 CSS 补充（`src/app/globals.css`）

在文件末尾追加:

```css
/* ─── Mobile 全局适配 ─── */

/* 安全区域内边距（刘海屏 / 底部横条） */
.safe-bottom { padding-bottom: env(safe-area-inset-bottom, 0px); }
.safe-top    { padding-top: env(safe-area-inset-top, 0px); }

/* 防止 iOS 输入框聚焦时缩放 — 所有 input/select/textarea 字号 ≥ 16px */
@media (max-width: 767px) {
  input, select, textarea {
    font-size: 16px !important;
  }
}

/* 触摸设备禁用 hover 状态（补充现有 @media (hover: hover) 规则） */
@media (hover: none) {
  .expand-btn .expand-label {
    max-width: 0 !important;
    padding: 0 !important;
    opacity: 0 !important;
  }
}

/* 底部 Tab 栏上方的安全区域 */
.bottom-tab-safe {
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 0.5rem);
}

/* 手机端滚动优化 */
@media (max-width: 767px) {
  .mobile-scroll {
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-y: contain;
  }
}
```

---

## 二、导航系统改造

### 当前问题

- `Sidebar` 固定在左侧，宽度 64px（收起）/ 224px（展开），手机上占据过多空间
- 无底部导航，无汉堡菜单

### 方案

桌面端保持现有 `Sidebar` 不变。手机端用 **底部 Tab 栏 + 左侧滑出抽屉** 替代。

### 2.1 新建 `src/components/mobile/BottomTabBar.tsx`

```
┌─────────────────────────────────────┐
│  🏠      📁      ➕      🔗      👤  │
│ 首页    文件夹   新建    分享    我的  │
└─────────────────────────────────────┘
```

**规格**:
- 固定在视口底部，`position: fixed; bottom: 0; left: 0; right: 0; z-index: 50`
- 高度: `56px + env(safe-area-inset-bottom)`
- 背景: `bg-white/95 backdrop-blur-md border-t border-cream-200`
- 5 个 Tab: 首页(`/home`)、文件夹(`/folders`)、新建会话(`/session/new`)、分享(`/shared`)、我的（打开抽屉）
- 当前 Tab 高亮: `text-rust-500`，其余 `text-charcoal-400`
- 新建按钮特殊样式: 中间突出圆形按钮（`bg-rust-500 text-white rounded-full w-12 h-12 -mt-4 shadow-lg`）
- 图标用 lucide-react: `Home`, `FolderOpen`, `Plus`, `Share2`, `User`

**Props**:
```typescript
interface BottomTabBarProps {
  onProfileTap: () => void;  // 点击「我的」打开抽屉
}
```

### 2.2 新建 `src/components/mobile/MobileDrawer.tsx`

从左侧滑出的抽屉，替代桌面端 Sidebar 的用户信息和管理功能。

```
┌──────────────────────┐
│  头像  用户名          │
│  email@example.com   │
│─────────────────────│
│  📊 用量配额          │
│  ██████░░░ 65%       │
│─────────────────────│
│  ⚙️ 账户设置          │
│  🛡️ 管理面板 (仅admin) │
│─────────────────────│
│  🚪 退出登录          │
└──────────────────────┘
```

**规格**:
- 宽度: `w-[280px]`，从左侧滑入
- 背景遮罩: `bg-black/40`，点击关闭
- 过渡动画: `transform transition-transform duration-300`
- 支持右滑关闭手势（touch 事件）

### 2.3 修改 `src/app/(dashboard)/layout.tsx`

**改动逻辑**:

```tsx
const isMobile = useIsMobile();
const [drawerOpen, setDrawerOpen] = useState(false);

return (
  <AuthGuard>
    {/* 桌面端: 保持现有 Sidebar */}
    {!isMobile && !isAdminPage && <Sidebar />}

    {/* 主内容区域 */}
    <main className={isMobile ? 'pb-20' : (sidebarCollapsed ? 'ml-16' : 'ml-56')}>
      {children}
    </main>

    {/* 手机端: 底部 Tab + 抽屉 */}
    {isMobile && !isSessionPage && (
      <BottomTabBar onProfileTap={() => setDrawerOpen(true)} />
    )}
    {isMobile && (
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    )}

    <UserSettingsModal ... />
  </AuthGuard>
);
```

**注意**:
- 会话录制页 (`/session/[id]`) 不显示底部 Tab（录制页有自己的控制栏）
- `pb-20`（80px）为底部 Tab 栏预留空间
- 管理员页面也需要底部 Tab，但管理面板入口放在抽屉里

---

## 三、会话录制页（核心改造）

### 当前桌面端布局

```
┌─ Sidebar ─┬─ Header (sticky) ──────────────────────────────────┐
│            │  Title | Status Badge | [Rec][Stop][Share][Export] │
│  w-56      ├────────────────────────────────────────────────────┤
│            │  TranscriptPanel (flex-1)  │  AiPanel (w-[380px])  │
│            │                            │  ┌─ Summary ─┐       │
│            │                            │  │  Chat      │       │
│            │                            │  │  Keywords  │       │
│            │                            │  └────────────┘       │
└────────────┴────────────────────────────┴───────────────────────┘
```

### 手机端目标布局

```
┌──────────────────────────────┐
│ ←  标题（可编辑）      ⚙️  ⋯  │  ← 精简 Header (h-12)
├──────────────────────────────┤
│                              │
│                              │
│       全屏内容区域             │  ← 根据当前 Tab 显示
│   TranscriptPanel            │     其中一个面板
│   / TranslationPanel         │
│   / SummaryTab               │
│   / ChatTab                  │
│   / KeywordTab               │
│                              │
│                              │
├──────────────────────────────┤
│ 📝  🌐  📊  💬  🔑           │  ← 内容切换 Tab (h-10)
├──────────────────────────────┤
│ ⏺ REC 00:12:34  ⏸ ⏹ 🎤     │  ← 录制控制栏 (h-14)
└──────────────────────────────┘
    ↑ safe-area-inset-bottom
```

### 3.1 新建 `src/components/mobile/MobileSessionHeader.tsx`

精简版 Header，一行显示所有关键信息。

**规格**:
- 高度: `h-12`
- 左侧: 返回按钮（`←`，`router.back()`）+ 标题（截断，点击编辑）
- 右侧: 状态 badge（精简为小圆点 + 时间）+ 设置按钮 + 更多菜单（`⋯`）
- 更多菜单（底部弹出 ActionSheet）: 导出、分享、画中画

**Props**:
```typescript
interface MobileSessionHeaderProps {
  title: string;
  isEditing: boolean;
  editingTitle: string;
  onStartEdit: () => void;
  onConfirmEdit: () => void;
  onCancelEdit: () => void;
  onEditChange: (v: string) => void;
  // 状态
  recordingState: string;
  connectionState: string;
  elapsed: number;
  connectionMeta: { latencyMs: number | null; region: string | null; transcriptionLatencyMs: number | null };
  // 操作
  onOpenSettings: () => void;
  onOpenExport: () => void;
  onOpenShare: () => void;
  onTogglePip: () => void;
  isSharing: boolean;
  pipOpen: boolean;
  serviceAvailable: boolean | null;
  backupMeta: BackupMeta;
}
```

**更多菜单（ActionSheet）内容**:
- 📤 导出
- 📡 分享 / 停止分享
- 🖼 画中画
- 备份状态显示

### 3.2 新建 `src/components/mobile/MobileContentTabs.tsx`

底部内容切换 Tab 栏。

**规格**:
- 固定在录制控制栏上方
- 5 个 Tab: 转写、翻译、摘要、聊天、关键词
- 图标 + 文字（缩写）: `📝转写` `🌐译文` `📊摘要` `💬AI` `🔑词`
- 选中态: `border-b-2 border-rust-500 text-rust-600`
- 未选中: `text-charcoal-400`
- 支持左右滑动切换内容（touch 手势）

```typescript
type MobileTab = 'transcript' | 'translation' | 'summary' | 'chat' | 'keywords';

interface MobileContentTabsProps {
  activeTab: MobileTab;
  onChange: (tab: MobileTab) => void;
  hasTranslation: boolean;  // 未开启翻译时隐藏翻译 Tab
}
```

### 3.3 新建 `src/components/mobile/MobileControlBar.tsx`

固定在屏幕最底部的录制控制栏。

```
┌──────────────────────────────────────────┐
│  ● REC 00:12:34    [⏸暂停] [⏹停止] 🎤🔊 │
└──────────────────────────────────────────┘
```

**规格**:
- 固定底部: `fixed bottom-0 left-0 right-0 z-50`
- 高度: `h-14 + env(safe-area-inset-bottom)`
- 背景: `bg-white/95 backdrop-blur-md border-t border-cream-200`
- 左侧: 状态点 + 状态文字 + 计时器（字体 mono）
- 中间: 录制控制按钮（开始/暂停/恢复/停止）
  - 按钮尺寸 44x44px，触摸友好
  - 录制中: 暂停 + 停止
  - 暂停中: 恢复 + 停止
  - 空闲: 开始
  - 已停止: 查看回放
- 右侧: 麦克风指示（简化版 AudioLevelBar，3-5 格）

**Props**:
```typescript
interface MobileControlBarProps {
  recordingState: 'idle' | 'recording' | 'paused' | 'finalizing' | 'stopped';
  connectionState: string;
  elapsed: number;
  serviceAvailable: boolean | null;
  hasPendingSave: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onRetry: () => void;
  onViewPlayback: () => void;
}
```

### 3.4 新建 `src/components/mobile/MobileSessionLayout.tsx`

手机端会话页的整体布局容器，组合上述组件。

```typescript
interface MobileSessionLayoutProps {
  // 透传 session page 的所有状态和回调
  sessionId: string;
  sessionTitle: string;
  // ... 所有录制状态
  // ... 所有操作回调
}
```

**内部结构**:

```tsx
export default function MobileSessionLayout(props: MobileSessionLayoutProps) {
  const [activeTab, setActiveTab] = useState<MobileTab>('transcript');

  return (
    <div className="flex flex-col h-screen bg-cream-50">
      {/* Header */}
      <MobileSessionHeader {...headerProps} />

      {/* 内容区域 — 根据 activeTab 切换 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === 'transcript' && <TranscriptPanel />}
        {activeTab === 'translation' && <TranslationPanel />}
        {activeTab === 'summary' && <SummaryTab onManualSummary={...} />}
        {activeTab === 'chat' && <ChatTab onInjectKeywords={...} />}
        {activeTab === 'keywords' && <KeywordTab onInjectKeywords={...} />}
      </div>

      {/* 内容切换 Tab */}
      <MobileContentTabs activeTab={activeTab} onChange={setActiveTab} />

      {/* 录制控制栏 */}
      <MobileControlBar {...controlProps} />

      {/* 抽屉/弹出层 */}
      <SettingsDrawer ... />
      <ExportModal ... />
    </div>
  );
}
```

### 3.5 修改 `src/app/session/[id]/page.tsx`

**改动最小化** — 在 return 语句中根据 `isMobile` 切换:

```tsx
export default function ActiveSessionPage() {
  const isMobile = useIsMobile();
  // ... 所有现有 state/hooks 保持不变 ...

  if (isMobile) {
    return (
      <>
        <MobileSessionLayout
          sessionId={sessionId}
          sessionTitle={sessionTitle}
          recordingState={recordingState}
          connectionState={connectionState}
          connectionMeta={connectionMeta}
          elapsed={elapsed}
          // ... 透传所有状态和回调
        />
        <SessionFinalizingOverlay steps={finalizingSteps} visible={isFinalizing} />
      </>
    );
  }

  // 现有桌面端 JSX 完全不动
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main ...>
        ...
      </main>
    </div>
  );
}
```

### 3.6 子组件适配

以下现有组件需要**微调**以在手机端全屏使用时表现良好（通过传入 prop 或 CSS 类控制）:

#### `TranscriptPanel.tsx`
- 当前: `panel-card` 有 `rounded-xl border` 样式
- 手机端: 去掉圆角和边框（全屏使用），减小内边距
- 方案: 接受 `className` prop，手机端传入 `border-0 rounded-none`
- 减小 segment 间距: `gap-4` → 手机端 `gap-2`

#### `TranslationPanel.tsx`（新增独立渲染）
- 当前: 翻译文本嵌在 TranscriptPanel 的每个 segment 下方
- 手机端: 在翻译 Tab 中独立展示所有翻译内容
- 如果 TranslationPanel 已存在且独立，直接复用
- 否则新建 `MobileTranslationView.tsx`，从 `translationStore` 读取数据渲染

#### `SummaryTab.tsx` / `ChatTab.tsx` / `KeywordTab.tsx`
- 当前: 在 `AiPanel` 内作为 Tab 内容，宽度被限制在 380px
- 手机端: 作为全屏面板使用，`flex-1 w-full`
- 这三个组件应该已经是 `flex-1 overflow-hidden` 的，无需大改
- 确认: ChatTab 的输入框在手机端要 `position: sticky; bottom: 0`，不被键盘遮挡

#### `SettingsDrawer.tsx`
- 当前: `w-[420px] max-w-[90vw]`
- 手机端: 改为 **从底部滑出**（Bottom Sheet），宽度 100%，高度 85vh
- 方案: 在组件内加 `isMobile` 判断，切换动画方向和尺寸

#### `ExportModal.tsx`
- 当前: 居中弹窗 `w-[420px] max-w-full`
- 手机端: 改为底部弹出 Bottom Sheet
- 方案: 同上，组件内加 `isMobile` 判断

### 3.7 新建 `src/components/mobile/BottomSheet.tsx`

通用底部弹出层组件，多处复用。

**规格**:
- 背景遮罩 `bg-black/40`，点击关闭
- 内容区域从底部滑入: `transform translate-y-full → translate-y-0`
- 顶部拖拽条（灰色小横杠），支持下滑关闭手势
- 圆角: `rounded-t-2xl`
- 最大高度: `max-h-[85vh]`
- 内容区域可滚动

```typescript
interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  maxHeight?: string;  // 默认 '85vh'
}
```

### 3.8 新建 `src/hooks/useSwipeGesture.ts`

通用滑动手势 hook，用于:
- 内容区域左右滑动切换 Tab
- 抽屉/BottomSheet 滑动关闭

```typescript
interface SwipeOptions {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onSwipeDown?: () => void;
  threshold?: number;  // 默认 50px
}

export function useSwipeGesture(ref: RefObject<HTMLElement>, options: SwipeOptions): void;
```

---

## 四、新建会话页

### 当前桌面端布局

`src/app/session/new/page.tsx`:
- `flex h-screen` + Sidebar + 右侧表单区域
- 表单: `max-w-3xl mx-auto px-10 py-8`
- 各设置项横向排列: `flex items-center gap-3`，label 宽 `w-20`

### 手机端目标布局

```
┌──────────────────────────────┐
│ ←  新建会话                   │  ← 顶部导航栏
├──────────────────────────────┤
│                              │
│  课程/主题名称                │
│  [______________________]    │
│                              │
│  源语言                       │
│  [English             ▼]     │
│          ↓                   │
│  目标语言                     │
│  [中文               ▼]      │
│                              │
│  主题                        │
│  [______________________]    │
│                              │
│  ASR 区域                    │
│  [自动 ▼]                    │
│                              │
│  文件夹                      │
│  [无] [文件夹A] [文件夹B] ... │  ← 横向滚动
│                              │
│  音频来源                     │
│  [● 麦克风]  [○ 系统音频]    │
│                              │
│  🎤 麦克风选择                │
│  [内置麦克风          ▼]     │
│  ████████░░░░ 音量指示        │
│                              │
│  ┌──────────────────────┐    │
│  │     ⏺ 开始录制        │    │  ← 全宽按钮
│  └──────────────────────┘    │
│                              │
└──────────────────────────────┘
```

### 4.1 修改 `src/app/session/new/page.tsx`

**改动方式**: 在 return 中判断 `isMobile`

**桌面端**: 完全不变

**手机端**:
- 隐藏 Sidebar
- 表单容器: `px-4 py-6 w-full`（取消 `max-w-3xl` 限制）
- 标题: `text-xl`（从 `text-3xl` 缩小）
- 所有 label + input 改为**纵向堆叠**: label 在上方（`text-sm font-medium text-charcoal-600 mb-1`），input 全宽
- 语言选择器: 两个下拉框纵向堆叠，中间箭头变为 `↓`
- 文件夹按钮组: 支持横向滚动 `overflow-x-auto flex gap-2 pb-2`
- 音频选择: 两个选项卡按钮，全宽平分
- 开始录制按钮: 全宽，高度 48px，固定在页面底部或表单末尾

**顶部导航**: 不用 BottomTabBar（这是创建流程页面），用简单的 `← 新建会话` 顶栏，返回 `/home`

---

## 五、首页

### 当前桌面端布局

`src/app/(dashboard)/home/page.tsx`:
- 问候语 + 新建按钮（flex justify-between）
- 搜索框（全宽）
- 会话列表（纵向滚动）
- 底部统计栏（3 列网格）

### 手机端目标布局

```
┌──────────────────────────────┐
│  早上好，用户 👋              │
│  ┌──────────────────────┐    │
│  │     ➕ 新建会话       │    │
│  └──────────────────────┘    │
│                              │
│  🔍 搜索会话...              │
│                              │
│  ┌──────────────────────┐    │
│  │ 📄 机器学习第三讲      │    │
│  │ 03/25 · 45:12 · 已完成 │   │  ← 卡片列表
│  └──────────────────────┘    │
│  ┌──────────────────────┐    │
│  │ 📄 数据结构期中复习    │    │
│  │ 03/24 · 1:20:05 · 录中 │   │
│  └──────────────────────┘    │
│  ...                         │
│                              │
│  📊 3 会话 · 2.5h · 12k字   │  ← 简化统计
│                              │
│  [底部 Tab 栏]               │
└──────────────────────────────┘
```

### 5.1 修改 `src/app/(dashboard)/home/page.tsx`

**手机端改动**:
- 问候语 + 新建按钮**纵向堆叠**: 问候在上，按钮在下（全宽）
- 内边距: `px-4 py-4`（从 `px-8 lg:px-12`）
- 搜索框: 保持全宽，减小 padding
- 会话列表: 卡片式（现有的列表项加大内边距和触摸区域）
  - 每项高度至少 64px
  - 标题 `text-base font-medium`
  - 副信息: 日期 + 时长 + 状态，`text-xs text-charcoal-400`
  - 右侧: 状态 badge 或 `>` 箭头
- 底部统计: 从 3 列网格改为**单行横排**（数字 + 标签缩写）
- 列表底部留 `pb-24` 给底部 Tab 栏

---

## 六、文件夹页

### 当前桌面端布局

`src/app/(dashboard)/folders/page.tsx`:
- 左侧文件夹树 + 右侧内容
- 右键菜单操作

### 手机端目标布局

```
┌──────────────────────────────┐
│ ←  文件夹         ➕ 新建    │
├──────────────────────────────┤
│  📁 课程笔记          (12) > │
│  📁 期末复习          (5)  > │
│  📁 科研项目          (3)  > │
│                              │
│  [底部 Tab 栏]               │
└──────────────────────────────┘

点击 "课程笔记" 后 →

┌──────────────────────────────┐
│ ← 课程笔记          ⋯ 编辑  │
├──────────────────────────────┤
│  📁 机器学习               > │  ← 子文件夹
│  📁 数据结构               > │
│─────────────────────────────│
│  📄 第三讲                   │  ← 该文件夹的会话
│  📄 第二讲                   │
│                              │
│  🏷 关键词: CNN, RNN, LSTM   │  ← 文件夹关键词
│                              │
│  [底部 Tab 栏]               │
└──────────────────────────────┘
```

### 6.1 修改策略

**手机端**:
- 树形结构改为**列表导航**（点击进入，顶部面包屑/返回键）
- 右键菜单 → **长按**弹出 ActionSheet（重命名、移动、删除）
- 文件夹 + 会话混合列表，文件夹在前
- 关键词以 Tag 形式显示在文件夹页底部

---

## 七、分享页

### 当前桌面端布局

`src/app/(dashboard)/shared/page.tsx`:
- 两列网格: "我分享的" + "分享给我的"

### 手机端目标布局

**手机端**: 两个 Section 纵向堆叠，卡片列表。

- 复制链接按钮: 明显的 `📋 复制` 按钮，触摸友好
- 打开链接按钮: 全宽或半宽
- 已使用 `xl:grid-cols-2`，手机端自动单列

**改动量极小**，主要是:
- 减小内边距
- 确保按钮触摸面积 ≥ 44x44px

---

## 八、登录/注册页

### 当前布局

`src/app/(auth)/login/page.tsx` 和 `register/page.tsx`:
- 居中表单，已基本适配移动端

### 手机端微调

- 确保 `px-4` 边距
- Logo 缩小
- 输入框高度 ≥ 48px
- 按钮高度 ≥ 48px
- 不显示底部 Tab（auth 页面在 dashboard 外）

---

## 九、观众页（Live Share Viewer）

### 当前布局

`src/app/session/[id]/view/page.tsx`:
- 独立页面，不依赖 Sidebar
- 有字体大小控制、紧凑模式切换
- 转写 + 翻译显示

### 手机端目标布局

```
┌──────────────────────────────┐
│ 📡 实时观看: 机器学习第三讲   │
│ 🔴 LIVE · 3 viewers         │
├──────────────────────────────┤
│                              │
│  全屏内容区域                 │
│  (转写 / 翻译 / 摘要)        │
│                              │
│                              │
├──────────────────────────────┤
│  📝转写  🌐翻译  📊摘要      │  ← Tab 切换
├──────────────────────────────┤
│  Aa 字号  🔄 紧凑  ⬇️ 滚动   │  ← 工具栏
└──────────────────────────────┘
```

### 9.1 修改策略

- Header 精简为一行
- 内容区域全屏
- Tab 切换（转写/翻译/摘要）
- 底部工具栏: 字号控制 + 紧凑切换 + 自动滚动
- 改动量中等

---

## 十、管理员面板

### 当前桌面端布局

`src/app/(dashboard)/admin/page.tsx`:
- 左侧 Tab 导航 (`w-56`)
- 右侧内容面板

### 手机端目标布局

```
┌──────────────────────────────┐
│ ← 管理面板                   │
├──────────────────────────────┤
│ [仪表盘] [设置] [用户] [日志] │  ← 顶部可滑动 Tab
├──────────────────────────────┤
│                              │
│     面板内容                  │
│     (全屏显示)                │
│                              │
│  [底部 Tab 栏]               │
└──────────────────────────────┘
```

### 10.1 修改策略

- 左侧 Tab 导航 → **顶部水平 Tab 栏**（可横向滚动）
- 表格类内容（用户列表、日志）→ **卡片列表**
- 统计面板: 从多列网格改为单列纵向
- 表单（站点设置、LLM 配置）: 全宽纵向布局

---

## 十一、新增文件清单

```
src/
├── hooks/
│   ├── useIsMobile.ts                    # 新增
│   └── useSwipeGesture.ts               # 新增
├── components/
│   └── mobile/
│       ├── BottomTabBar.tsx              # 新增 — 底部导航
│       ├── MobileDrawer.tsx             # 新增 — 侧滑抽屉
│       ├── MobileSessionLayout.tsx      # 新增 — 会话页布局容器
│       ├── MobileSessionHeader.tsx      # 新增 — 会话页精简 Header
│       ├── MobileContentTabs.tsx        # 新增 — 内容切换 Tab
│       ├── MobileControlBar.tsx         # 新增 — 录制控制栏
│       ├── BottomSheet.tsx              # 新增 — 通用底部弹出层
│       └── ActionSheet.tsx              # 新增 — 操作菜单（长按/更多）
└── app/
    └── manifest.json                    # 新增 — PWA 配置
```

## 十二、需修改的现有文件

| 文件 | 改动范围 | 说明 |
|------|---------|------|
| `src/app/layout.tsx` | 小 | 添加 PWA meta 标签、viewport 配置 |
| `src/app/globals.css` | 小 | 添加安全区域 CSS、移动端全局样式 |
| `src/app/(dashboard)/layout.tsx` | 中 | 手机端隐藏 Sidebar，显示 BottomTabBar |
| `src/app/session/[id]/page.tsx` | 中 | 顶层 return 分叉: 手机端用 MobileSessionLayout |
| `src/app/session/new/page.tsx` | 中 | 手机端表单纵向堆叠布局 |
| `src/app/(dashboard)/home/page.tsx` | 小 | 响应式调整间距和布局 |
| `src/app/(dashboard)/folders/page.tsx` | 中 | 手机端列表导航替代树形 |
| `src/app/(dashboard)/shared/page.tsx` | 小 | 微调间距和按钮尺寸 |
| `src/app/(dashboard)/admin/page.tsx` | 中 | Tab 导航改为顶部水平 |
| `src/app/session/[id]/view/page.tsx` | 中 | 手机端 Tab 切换 + 工具栏 |
| `src/components/SettingsDrawer.tsx` | 小 | 手机端改为 BottomSheet |
| `src/components/ExportModal.tsx` | 小 | 手机端改为 BottomSheet |
| `src/components/TranscriptPanel.tsx` | 小 | 接受 className prop，手机端去圆角 |
| `src/components/session/AiPanel.tsx` | 无 | 手机端不使用此组件，直接用内部 Tab 组件 |
| `tailwind.config.ts` | 无 | 使用默认断点即可 |

## 十三、实施顺序

| 阶段 | 内容 | 涉及文件 | 预估复杂度 |
|------|------|---------|-----------|
| **P0** | 基础设施: `useIsMobile` + PWA + 全局 CSS | 3 个新文件 + 2 处修改 | 低 |
| **P1** | 导航: BottomTabBar + MobileDrawer + dashboard layout 改造 | 3 个新文件 + 1 处修改 | 中 |
| **P2** | 会话录制页: MobileSessionLayout + Header + ContentTabs + ControlBar | 5 个新文件 + 1 处修改 | **高** |
| **P3** | 通用组件: BottomSheet + ActionSheet + useSwipeGesture | 3 个新文件 | 中 |
| **P4** | 新建会话页适配 | 1 处修改 | 中 |
| **P5** | 首页 + 文件夹 + 分享页适配 | 3 处修改 | 中 |
| **P6** | 观众页适配 | 1 处修改 | 中 |
| **P7** | 管理员面板适配 | 1 处修改 | 中 |
| **P8** | SettingsDrawer + ExportModal 底部弹出改造 | 2 处修改 | 低 |

**建议从 P0 → P1 → P2 开始**，完成后已覆盖 80% 的使用场景。

---

## 十四、关键技术细节

### 14.1 键盘处理

手机端虚拟键盘弹出时会压缩视口高度。需要注意:
- 录制控制栏: 当 ChatTab 输入框获得焦点时，控制栏可能被键盘遮挡
- 方案: 使用 `visualViewport` API 监听键盘高度，动态调整底部偏移
- 或者: ChatTab 输入框 focus 时临时隐藏 MobileControlBar

```typescript
// src/hooks/useKeyboardHeight.ts
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const handler = () => {
      setHeight(window.innerHeight - vv.height);
    };
    vv.addEventListener('resize', handler);
    return () => vv.removeEventListener('resize', handler);
  }, []);
  return height;
}
```

### 14.2 音频录制注意事项

手机端浏览器对音频权限的限制更严格:
- iOS Safari: 需要用户明确交互（click/tap）后才能调用 `getUserMedia`
- 安卓 Chrome: 需要 HTTPS（或 localhost）
- 系统音频: `getDisplayMedia` 在手机浏览器上**不可用**，手机端应隐藏"系统音频"选项
- 后台录制: 手机浏览器切到后台后可能暂停 `MediaRecorder`
  - PWA standalone 模式下情况更好
  - 应在 UI 中提示用户保持屏幕常亮

### 14.3 手机端应隐藏/调整的功能

| 功能 | 处理方式 |
|------|---------|
| 系统音频录制 (`getDisplayMedia`) | 隐藏选项（手机不支持） |
| 画中画 (Document PiP) | 隐藏（仅 Chrome 桌面端支持） |
| 本地 ONNX 翻译 | 保留但标注"可能较慢"（手机 WebGPU 支持有限） |
| 右键菜单 | 改为长按菜单 |
| 悬停展开按钮 (`.expand-btn`) | 已通过 CSS 禁用 hover |

### 14.4 性能优化

- 手机端 TranscriptPanel 使用**虚拟滚动**（segment 数量多时），可选用 `react-window` 或 `@tanstack/react-virtual`
- 减少动画: `prefers-reduced-motion` 媒体查询
- 图片懒加载
- 减小 AudioLevelBar 的条数（32 → 8）

---

## 十五、测试矩阵

| 设备/浏览器 | 优先级 | 说明 |
|------------|--------|------|
| iPhone Safari (iOS 16+) | P0 | 主力设备 |
| iPhone Chrome (iOS) | P1 | WebKit 内核，行为接近 Safari |
| Android Chrome | P0 | 安卓主力 |
| Android Firefox | P2 | 小众但需兼容 |
| iPad Safari (竖屏) | P1 | 平板竖屏走手机布局 |

**测试重点**:
- 虚拟键盘弹出/收起时布局不跳
- 安全区域在有刘海的设备上正确显示
- 录制中切到后台再切回来，录制不中断
- PWA 添加到主屏幕后正常工作
- 长时间录制（30min+）内存不泄漏
