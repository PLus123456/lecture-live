'use client';

import { useState } from 'react';
import Link from 'next/link';

type Lang = 'en' | 'zh';

export default function PrivacyPage() {
  const [lang, setLang] = useState<Lang>('en');

  return (
    <div className="min-h-[100dvh] bg-cream-50 dark:bg-charcoal-900">
      {/* 顶部导航栏 */}
      <header className="sticky top-0 z-10 bg-cream-50/80 dark:bg-charcoal-900/80 backdrop-blur-sm border-b border-cream-300 dark:border-charcoal-700">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link
            href="/"
            className="text-charcoal-500 dark:text-charcoal-300 hover:text-rust-500 dark:hover:text-rust-400 transition-colors text-sm font-medium flex items-center gap-1.5"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            {lang === 'en' ? 'Back to Home' : '返回首页'}
          </Link>
          <div className="flex items-center gap-1 bg-cream-200 dark:bg-charcoal-700 rounded-lg p-0.5">
            <button
              onClick={() => setLang('en')}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                lang === 'en'
                  ? 'bg-white dark:bg-charcoal-600 text-charcoal-800 dark:text-cream-100 shadow-sm'
                  : 'text-charcoal-500 dark:text-charcoal-400 hover:text-charcoal-700 dark:hover:text-charcoal-200'
              }`}
            >
              EN
            </button>
            <button
              onClick={() => setLang('zh')}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                lang === 'zh'
                  ? 'bg-white dark:bg-charcoal-600 text-charcoal-800 dark:text-cream-100 shadow-sm'
                  : 'text-charcoal-500 dark:text-charcoal-400 hover:text-charcoal-700 dark:hover:text-charcoal-200'
              }`}
            >
              中文
            </button>
          </div>
        </div>
      </header>

      {/* 正文内容 */}
      <main className="max-w-4xl mx-auto px-6 py-12">
        {lang === 'en' ? <EnglishPrivacy /> : <ChinesePrivacy />}
      </main>

      {/* 页脚 */}
      <footer className="border-t border-cream-300 dark:border-charcoal-700">
        <div className="max-w-4xl mx-auto px-6 py-8 text-center text-sm text-charcoal-400 dark:text-charcoal-500">
          <p>&copy; {new Date().getFullYear()} LectureLive. {lang === 'en' ? 'All rights reserved.' : '保留所有权利。'}</p>
          <div className="mt-2 flex justify-center gap-4">
            <Link href="/privacy" className="hover:text-rust-500 dark:hover:text-rust-400 transition-colors">
              {lang === 'en' ? 'Privacy Policy' : '隐私政策'}
            </Link>
            <span>|</span>
            <Link href="/terms" className="hover:text-rust-500 dark:hover:text-rust-400 transition-colors">
              {lang === 'en' ? 'Terms of Service' : '使用条款'}
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ==================== 英文版本 ==================== */
function EnglishPrivacy() {
  return (
    <article className="prose prose-charcoal dark:prose-invert max-w-none prose-headings:text-charcoal-800 dark:prose-headings:text-cream-100 prose-a:text-rust-500 dark:prose-a:text-rust-400 prose-strong:text-charcoal-800 dark:prose-strong:text-cream-100">
      <h1 className="text-4xl font-bold mb-2">Privacy Policy</h1>
      <p className="text-charcoal-400 dark:text-charcoal-500 text-sm !mt-0 mb-10">
        Last Updated: March 21, 2026
      </p>

      <p>
        LectureLive (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) is
        committed to protecting your privacy. This Privacy Policy explains how we
        collect, use, store, and protect your personal information when you use the
        LectureLive web application (the &ldquo;Service&rdquo;).
      </p>

      <h2>1. Information We Collect</h2>

      <h3>1.1 Account Information</h3>
      <p>When you create an account, we collect:</p>
      <ul>
        <li>Email address;</li>
        <li>Display name;</li>
        <li>Password (stored as a bcrypt hash &mdash; we never store your plaintext password).</li>
      </ul>

      <h3>1.2 Usage Data</h3>
      <p>When you use the Service, we may collect:</p>
      <ul>
        <li>Session metadata (creation time, duration, language settings);</li>
        <li>Transcription content generated during sessions;</li>
        <li>Audio recordings (if you choose to enable recording);</li>
        <li>AI-generated summaries and keyword data;</li>
        <li>Export history and preferences.</li>
      </ul>

      <h3>1.3 Technical Data</h3>
      <p>We automatically collect certain technical information, including:</p>
      <ul>
        <li>Browser type and version;</li>
        <li>IP address (used for rate limiting and security purposes only; not stored long-term);</li>
        <li>Device type and operating system;</li>
        <li>General usage patterns and feature interactions.</li>
      </ul>

      <h2>2. How We Use Your Information</h2>
      <p>We use the information we collect to:</p>
      <ul>
        <li><strong>Provide core services</strong> &mdash; real-time transcription, translation, and session management;</li>
        <li><strong>Generate AI-powered features</strong> &mdash; summaries, keyword extraction, and intelligent note-taking;</li>
        <li><strong>Manage your account</strong> &mdash; authentication, authorization, and account settings;</li>
        <li><strong>Improve the Service</strong> &mdash; analyze usage patterns to enhance features and fix bugs;</li>
        <li><strong>Ensure security</strong> &mdash; detect and prevent abuse, unauthorized access, and fraud;</li>
        <li><strong>Communicate with you</strong> &mdash; send service-related notices, updates, and support responses.</li>
      </ul>

      <h2>3. Third-Party Services</h2>
      <p>
        To deliver our core features, we share certain data with trusted third-party
        service providers:
      </p>

      <h3>3.1 Soniox (Speech Recognition)</h3>
      <p>
        Audio data from your microphone is transmitted in real time to Soniox servers for
        automatic speech recognition. Audio is processed in real time and is not
        permanently stored by Soniox after processing is complete. Please refer to
        Soniox&apos;s privacy policy for details on their data handling practices.
      </p>

      <h3>3.2 LLM Providers (Claude / GPT / DeepSeek)</h3>
      <p>
        Transcription text may be sent to large language model providers &mdash; including
        Anthropic (Claude), OpenAI (GPT), and DeepSeek &mdash; for the following purposes:
      </p>
      <ul>
        <li>Generating AI summaries of lecture content;</li>
        <li>Extracting keywords and key concepts;</li>
        <li>Translating transcription content.</li>
      </ul>
      <p>
        Only the transcription text is sent; audio data is never shared with LLM
        providers. Each provider is governed by its own privacy policy and data retention
        practices.
      </p>

      <h3>3.3 Cloudreve (Optional Cloud Storage)</h3>
      <p>
        If you choose to use cloud storage, session data and recordings may be stored
        on a Cloudreve instance. This is an optional feature and no data is uploaded to
        cloud storage without your explicit action.
      </p>

      <h2>4. Data Storage and Security</h2>
      <p>We implement appropriate technical and organizational measures to protect your data:</p>
      <ul>
        <li><strong>Authentication</strong> &mdash; JSON Web Tokens (JWT) with HttpOnly cookies for secure session management;</li>
        <li><strong>Password security</strong> &mdash; all passwords are hashed using bcrypt before storage;</li>
        <li><strong>Transport encryption</strong> &mdash; all data in transit is protected by HTTPS/TLS encryption;</li>
        <li><strong>Storage</strong> &mdash; session data is stored locally or in your configured Cloudreve instance;</li>
        <li><strong>Access control</strong> &mdash; role-based access ensures users can only access their own data and sessions they are invited to.</li>
      </ul>

      <h2>5. Data Retention</h2>
      <ul>
        <li><strong>Account data</strong> &mdash; retained for as long as your account is active, and deleted upon account deletion;</li>
        <li><strong>Session data</strong> &mdash; retained according to per-user storage quotas. Older sessions may be automatically archived or removed when quotas are exceeded;</li>
        <li><strong>Audio recordings</strong> &mdash; retained per user quota settings. You may delete recordings at any time;</li>
        <li><strong>Technical logs</strong> &mdash; IP addresses and access logs are retained for a limited period (typically no more than 30 days) for security purposes.</li>
      </ul>

      <h2>6. Your Rights</h2>
      <p>You have the following rights regarding your personal data:</p>
      <ul>
        <li><strong>Access</strong> &mdash; you may view all data associated with your account at any time through the Service;</li>
        <li><strong>Correction</strong> &mdash; you may update your account information, display name, and preferences;</li>
        <li><strong>Deletion</strong> &mdash; you may delete individual sessions, recordings, or your entire account;</li>
        <li><strong>Export</strong> &mdash; you may export your session data in multiple formats, including JSON, Markdown, SRT, and TXT;</li>
        <li><strong>Restriction</strong> &mdash; you may request that we limit the processing of your data in certain circumstances.</li>
      </ul>
      <p>
        To exercise any of these rights, you may use the built-in account management
        features or contact us at{' '}
        <a href="mailto:support@lecturelive.com">support@lecturelive.com</a>.
      </p>

      <h2>7. Cookies and Local Storage</h2>

      <h3>7.1 Cookies</h3>
      <p>
        We use a single essential cookie for authentication purposes: an HttpOnly JWT
        cookie that maintains your login session. This cookie is strictly necessary for
        the operation of the Service and cannot be opted out of while using the Service.
      </p>

      <h3>7.2 Local Storage</h3>
      <p>
        We use browser localStorage to store non-sensitive UI preferences, such as:
      </p>
      <ul>
        <li>Theme preference (light/dark mode);</li>
        <li>Language settings;</li>
        <li>UI layout preferences.</li>
      </ul>
      <p>
        No personal data or authentication tokens are stored in localStorage.
      </p>

      <h2>8. Children&apos;s Privacy</h2>
      <p>
        The Service is not directed to children under the age of 13. We do not knowingly
        collect personal information from children under 13. If you are a parent or
        guardian and believe that your child has provided us with personal information,
        please contact us at{' '}
        <a href="mailto:support@lecturelive.com">support@lecturelive.com</a>, and we
        will take steps to delete such information.
      </p>

      <h2>9. Changes to This Policy</h2>
      <p>
        We may update this Privacy Policy from time to time to reflect changes in our
        practices or for legal, regulatory, or operational reasons. We will notify
        registered users of material changes by posting a notice on the Service or
        sending an email. The updated policy will be effective as of the date posted.
      </p>

      <h2>10. Contact Us</h2>
      <p>
        If you have any questions, concerns, or requests regarding this Privacy Policy
        or our data practices, please contact us at:
      </p>
      <p>
        <strong>Email:</strong>{' '}
        <a href="mailto:support@lecturelive.com">support@lecturelive.com</a>
      </p>
    </article>
  );
}

/* ==================== 中文版本 ==================== */
function ChinesePrivacy() {
  return (
    <article className="prose prose-charcoal dark:prose-invert max-w-none prose-headings:text-charcoal-800 dark:prose-headings:text-cream-100 prose-a:text-rust-500 dark:prose-a:text-rust-400 prose-strong:text-charcoal-800 dark:prose-strong:text-cream-100">
      <h1 className="text-4xl font-bold mb-2">隐私政策</h1>
      <p className="text-charcoal-400 dark:text-charcoal-500 text-sm !mt-0 mb-10">
        最后更新日期：2026 年 3 月 21 日
      </p>

      <p>
        LectureLive（以下简称“我们”）重视您的隐私保护。本隐私政策说明了在您使用 LectureLive 网页应用程序（以下简称“本服务”）时，我们如何收集、使用、存储和保护您的个人信息。
      </p>

      <h2>一、我们收集的信息</h2>

      <h3>1.1 账户信息</h3>
      <p>创建账户时，我们会收集以下信息：</p>
      <ul>
        <li>电子邮件地址；</li>
        <li>显示名称；</li>
        <li>密码（以 bcrypt 哈希形式存储，我们不会存储您的明文密码）。</li>
      </ul>

      <h3>1.2 使用数据</h3>
      <p>使用本服务时，我们可能收集以下信息：</p>
      <ul>
        <li>会话元数据（创建时间、持续时间、语言设置）；</li>
        <li>会话中生成的转录内容；</li>
        <li>音频录制文件（如您选择开启录音功能）；</li>
        <li>AI 生成的摘要和关键词数据；</li>
        <li>导出记录和偏好设置。</li>
      </ul>

      <h3>1.3 技术数据</h3>
      <p>我们会自动收集某些技术信息，包括：</p>
      <ul>
        <li>浏览器类型和版本；</li>
        <li>IP 地址（仅用于速率限制和安全目的，不进行长期存储）；</li>
        <li>设备类型和操作系统；</li>
        <li>一般性的使用模式和功能交互数据。</li>
      </ul>

      <h2>二、我们如何使用您的信息</h2>
      <p>我们使用所收集的信息用于以下目的：</p>
      <ul>
        <li><strong>提供核心服务</strong> —— 实时转录、翻译和会话管理；</li>
        <li><strong>生成 AI 功能</strong> —— 摘要、关键词提取和智能笔记；</li>
        <li><strong>账户管理</strong> —— 身份验证、授权和账户设置维护；</li>
        <li><strong>改进服务</strong> —— 分析使用模式以优化功能和修复缺陷；</li>
        <li><strong>保障安全</strong> —— 检测和防止滥用、未授权访问和欺诈行为；</li>
        <li><strong>与您沟通</strong> —— 发送服务相关通知、更新和技术支持回复。</li>
      </ul>

      <h2>三、第三方服务</h2>
      <p>
        为提供核心功能，我们会与以下可信的第三方服务提供商共享特定数据：
      </p>

      <h3>3.1 Soniox（语音识别）</h3>
      <p>
        来自您麦克风的音频数据将实时传输至 Soniox 服务器进行自动语音识别。音频数据仅在处理过程中使用，处理完成后不会被 Soniox 永久存储。有关其数据处理方式的详情，请参阅 Soniox 的隐私政策。
      </p>

      <h3>3.2 大语言模型提供商（Claude / GPT / DeepSeek）</h3>
      <p>
        转录文本可能会被发送至大语言模型提供商 —— 包括 Anthropic（Claude）、OpenAI（GPT）和 DeepSeek —— 用于以下目的：
      </p>
      <ul>
        <li>生成课堂内容的 AI 摘要；</li>
        <li>提取关键词和核心概念；</li>
        <li>翻译转录内容。</li>
      </ul>
      <p>
        仅转录文本会被发送；音频数据绝不会与大语言模型提供商共享。各提供商受其各自的隐私政策和数据保留政策约束。
      </p>

      <h3>3.3 Cloudreve（可选云存储）</h3>
      <p>
        如果您选择使用云存储功能，会话数据和录音文件可能存储在 Cloudreve 实例上。这是一项可选功能，未经您明确操作，不会将任何数据上传到云存储。
      </p>

      <h2>四、数据存储与安全</h2>
      <p>我们采取了适当的技术和组织措施来保护您的数据：</p>
      <ul>
        <li><strong>身份验证</strong> —— 使用 JSON Web Token（JWT）和 HttpOnly Cookie 实现安全的会话管理；</li>
        <li><strong>密码安全</strong> —— 所有密码在存储前均使用 bcrypt 进行哈希处理；</li>
        <li><strong>传输加密</strong> —— 所有传输中的数据均受 HTTPS/TLS 加密保护；</li>
        <li><strong>数据存储</strong> —— 会话数据存储在本地或您配置的 Cloudreve 实例中；</li>
        <li><strong>访问控制</strong> —— 基于角色的访问控制确保用户只能访问自己的数据及其被邀请参与的会话。</li>
      </ul>

      <h2>五、数据保留</h2>
      <ul>
        <li><strong>账户数据</strong> —— 在您的账户处于活跃状态期间保留，账户注销后删除；</li>
        <li><strong>会话数据</strong> —— 根据用户存储配额保留。超出配额时，较旧的会话可能被自动归档或删除；</li>
        <li><strong>音频录制</strong> —— 根据用户配额设置保留，您可随时删除录音文件；</li>
        <li><strong>技术日志</strong> —— IP 地址和访问日志出于安全目的保留有限期限（通常不超过 30 天）。</li>
      </ul>

      <h2>六、您的权利</h2>
      <p>关于您的个人数据，您享有以下权利：</p>
      <ul>
        <li><strong>访问权</strong> —— 您可随时通过本服务查看与您账户相关的所有数据；</li>
        <li><strong>更正权</strong> —— 您可更新您的账户信息、显示名称和偏好设置；</li>
        <li><strong>删除权</strong> —— 您可删除单个会话、录音文件或注销整个账户；</li>
        <li><strong>导出权</strong> —— 您可将会话数据导出为多种格式，包括 JSON、Markdown、SRT 和 TXT；</li>
        <li><strong>限制处理权</strong> —— 在特定情况下，您可要求我们限制对您数据的处理。</li>
      </ul>
      <p>
        如需行使上述任何权利，您可使用内置的账户管理功能，或通过{' '}
        <a href="mailto:support@lecturelive.com">support@lecturelive.com</a> 与我们联系。
      </p>

      <h2>七、Cookie 和本地存储</h2>

      <h3>7.1 Cookie</h3>
      <p>
        我们使用一个必要的 Cookie 用于身份验证：一个 HttpOnly 的 JWT Cookie 来维持您的登录会话。此 Cookie 是本服务正常运行所必需的，在使用本服务期间无法选择退出。
      </p>

      <h3>7.2 本地存储（localStorage）</h3>
      <p>
        我们使用浏览器的 localStorage 存储非敏感的界面偏好设置，包括：
      </p>
      <ul>
        <li>主题偏好（浅色/深色模式）；</li>
        <li>语言设置；</li>
        <li>界面布局偏好。</li>
      </ul>
      <p>
        localStorage 中不会存储任何个人数据或身份验证令牌。
      </p>

      <h2>八、儿童隐私</h2>
      <p>
        本服务不面向 13 岁以下的儿童。我们不会故意收集 13 岁以下儿童的个人信息。如果您是家长或监护人，认为您的孩子向我们提供了个人信息，请通过{' '}
        <a href="mailto:support@lecturelive.com">support@lecturelive.com</a>{' '}
        联系我们，我们将采取措施删除相关信息。
      </p>

      <h2>九、政策变更</h2>
      <p>
        我们可能会不定期更新本隐私政策，以反映我们做法的变化或基于法律、监管或运营原因进行调整。对于重大变更，我们将通过在本服务上发布通知或发送电子邮件的方式通知注册用户。更新后的政策自发布之日起生效。
      </p>

      <h2>十、联系我们</h2>
      <p>
        如您对本隐私政策或我们的数据处理方式有任何疑问、意见或请求，请通过以下方式联系我们：
      </p>
      <p>
        <strong>电子邮件：</strong>{' '}
        <a href="mailto:support@lecturelive.com">support@lecturelive.com</a>
      </p>
    </article>
  );
}
