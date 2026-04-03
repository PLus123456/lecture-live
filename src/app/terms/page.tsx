'use client';

import { useState } from 'react';
import Link from 'next/link';

type Lang = 'en' | 'zh';

export default function TermsPage() {
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
        {lang === 'en' ? <EnglishTerms /> : <ChineseTerms />}
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
function EnglishTerms() {
  return (
    <article className="prose prose-charcoal dark:prose-invert max-w-none prose-headings:text-charcoal-800 dark:prose-headings:text-cream-100 prose-a:text-rust-500 dark:prose-a:text-rust-400 prose-strong:text-charcoal-800 dark:prose-strong:text-cream-100">
      <h1 className="text-4xl font-bold mb-2">Terms of Service</h1>
      <p className="text-charcoal-400 dark:text-charcoal-500 text-sm !mt-0 mb-10">
        Last Updated: March 21, 2026
      </p>

      <h2>1. Acceptance of Terms</h2>
      <p>
        Welcome to LectureLive. By accessing or using the LectureLive web application
        (the &ldquo;Service&rdquo;), you agree to be bound by these Terms of Service
        (the &ldquo;Terms&rdquo;). If you do not agree to all of these Terms, you may
        not access or use the Service.
      </p>
      <p>
        We may update these Terms from time to time. Your continued use of the Service
        after any changes constitutes acceptance of the revised Terms. We encourage you
        to review these Terms periodically.
      </p>

      <h2>2. Description of Service</h2>
      <p>
        LectureLive is a web-based platform designed for academic and educational
        environments. The Service provides the following core features:
      </p>
      <ul>
        <li><strong>Real-time lecture transcription</strong> powered by automatic speech recognition (ASR) technology;</li>
        <li><strong>Real-time translation</strong> of transcribed content into multiple languages;</li>
        <li><strong>AI-powered summaries</strong> and keyword extraction from lecture sessions;</li>
        <li><strong>Collaborative sharing</strong> of live transcription sessions with other users;</li>
        <li><strong>Session recording and export</strong> in various formats (JSON, Markdown, SRT, TXT).</li>
      </ul>
      <p>
        The availability and accuracy of these features may vary depending on network
        conditions, audio quality, language support, and third-party service availability.
      </p>

      <h2>3. User Accounts</h2>
      <h3>3.1 Registration</h3>
      <p>
        To access certain features of the Service, you must create an account by providing
        a valid email address, a display name, and a secure password. You represent that
        all information you provide during registration is accurate and complete.
      </p>
      <h3>3.2 Account Security</h3>
      <p>
        You are responsible for maintaining the confidentiality of your account credentials
        and for all activities that occur under your account. You agree to notify us
        immediately of any unauthorized use of your account. LectureLive shall not be
        liable for any loss arising from unauthorized access to your account.
      </p>
      <h3>3.3 Account Responsibility</h3>
      <p>
        You are solely responsible for all content uploaded, transcribed, or generated
        through your account. You must not share your account credentials with third
        parties or allow others to access the Service through your account.
      </p>

      <h2>4. Acceptable Use</h2>
      <p>You agree to use the Service only for lawful purposes. You shall not:</p>
      <ul>
        <li>Use the Service to transcribe, record, or distribute content without the consent of all speakers or participants;</li>
        <li>Upload or transmit any material that infringes intellectual property rights of any third party;</li>
        <li>Attempt to reverse-engineer, decompile, or disassemble any part of the Service;</li>
        <li>Use automated tools, bots, or scrapers to access the Service without prior written consent;</li>
        <li>Interfere with or disrupt the integrity or performance of the Service;</li>
        <li>Use the Service to harass, defame, or threaten any individual;</li>
        <li>Transmit any viruses, malware, or other harmful code;</li>
        <li>Violate any applicable local, state, national, or international law or regulation.</li>
      </ul>
      <p>
        We reserve the right to suspend or terminate your account if we reasonably
        believe you have violated these Terms.
      </p>

      <h2>5. Intellectual Property</h2>
      <h3>5.1 User Content</h3>
      <p>
        You retain ownership of all content that you upload, create, or generate through
        the Service, including audio recordings, transcriptions, and notes. By using the
        Service, you grant LectureLive a limited, non-exclusive license to process your
        content solely for the purpose of providing the Service to you.
      </p>
      <h3>5.2 Platform Intellectual Property</h3>
      <p>
        The Service, including its design, code, algorithms, user interface, trademarks,
        and documentation, is the intellectual property of LectureLive and is protected
        by copyright and other intellectual property laws. You may not copy, modify,
        distribute, or create derivative works of the Service without our prior written
        consent.
      </p>

      <h2>6. Privacy</h2>
      <p>
        Your use of the Service is also governed by our{' '}
        <a href="/privacy">Privacy Policy</a>, which describes how we collect, use, and
        protect your personal information. By using the Service, you consent to the
        practices described in our Privacy Policy.
      </p>

      <h2>7. Third-Party Services</h2>
      <p>
        LectureLive integrates with the following third-party services to deliver its
        core functionality:
      </p>
      <ul>
        <li><strong>Soniox</strong> &mdash; provides automatic speech recognition (ASR). Audio data is transmitted to Soniox servers for real-time transcription processing.</li>
        <li><strong>Large Language Model (LLM) providers</strong> &mdash; including Anthropic (Claude), OpenAI (GPT), and DeepSeek. Transcription text may be sent to these services for AI-powered summary generation, keyword extraction, and translation.</li>
      </ul>
      <p>
        These third-party services are governed by their own terms of service and privacy
        policies. LectureLive does not control or assume responsibility for the practices
        of these third-party providers. We encourage you to review their respective
        policies.
      </p>

      <h2>8. Data Storage and Retention</h2>
      <p>
        Session data, transcriptions, and recordings are stored either locally or via
        optional cloud storage (Cloudreve). Storage is subject to per-user quotas.
        LectureLive does not guarantee indefinite retention of your data and recommends
        that you regularly export important content.
      </p>
      <p>
        You may delete your data at any time through the Service. Upon account deletion,
        all associated data will be permanently removed in accordance with our Privacy Policy.
      </p>

      <h2>9. Disclaimer of Warranties</h2>
      <p>
        THE SERVICE IS PROVIDED ON AN &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; BASIS,
        WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT
        LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
        PURPOSE, AND NON-INFRINGEMENT.
      </p>
      <p>
        LectureLive does not warrant that: (a) the Service will be uninterrupted, timely,
        secure, or error-free; (b) transcriptions will be accurate or complete; (c)
        AI-generated summaries will be free from errors or omissions; or (d) the Service
        will meet your specific requirements.
      </p>

      <h2>10. Limitation of Liability</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, LECTURELIVE AND ITS DIRECTORS,
        OFFICERS, EMPLOYEES, AND AGENTS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL,
        SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES ARISING OUT OF OR RELATED TO YOUR
        USE OF OR INABILITY TO USE THE SERVICE, INCLUDING BUT NOT LIMITED TO LOSS OF
        DATA, LOSS OF PROFITS, OR DAMAGE TO REPUTATION, EVEN IF LECTURELIVE HAS BEEN
        ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
      </p>
      <p>
        IN NO EVENT SHALL LECTURELIVE&apos;S TOTAL LIABILITY TO YOU FOR ALL CLAIMS
        ARISING OUT OF OR RELATED TO THESE TERMS OR THE SERVICE EXCEED THE AMOUNT YOU
        HAVE PAID TO LECTURELIVE IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM, OR
        ONE HUNDRED US DOLLARS (US$100), WHICHEVER IS GREATER.
      </p>

      <h2>11. Modifications to Terms</h2>
      <p>
        LectureLive reserves the right to modify these Terms at any time. We will notify
        registered users of material changes by posting a notice on the Service or
        sending an email to the address associated with your account. Changes will become
        effective upon posting unless otherwise stated. Your continued use of the Service
        after changes are posted constitutes your acceptance of the modified Terms.
      </p>

      <h2>12. Governing Law</h2>
      <p>
        These Terms shall be governed by and construed in accordance with the laws of the
        State of California, United States, without regard to its conflict of law
        provisions. Any disputes arising out of or relating to these Terms or the Service
        shall be resolved exclusively in the state or federal courts located in San
        Francisco County, California.
      </p>

      <h2>13. Contact Information</h2>
      <p>
        If you have any questions or concerns about these Terms of Service, please
        contact us at:
      </p>
      <p>
        <strong>Email:</strong>{' '}
        <a href="mailto:support@lecturelive.com">support@lecturelive.com</a>
      </p>
    </article>
  );
}

/* ==================== 中文版本 ==================== */
function ChineseTerms() {
  return (
    <article className="prose prose-charcoal dark:prose-invert max-w-none prose-headings:text-charcoal-800 dark:prose-headings:text-cream-100 prose-a:text-rust-500 dark:prose-a:text-rust-400 prose-strong:text-charcoal-800 dark:prose-strong:text-cream-100">
      <h1 className="text-4xl font-bold mb-2">使用条款</h1>
      <p className="text-charcoal-400 dark:text-charcoal-500 text-sm !mt-0 mb-10">
        最后更新日期：2026 年 3 月 21 日
      </p>

      <h2>一、条款的接受</h2>
      <p>
        欢迎使用 LectureLive。访问或使用 LectureLive 网页应用程序（以下简称“本服务”）即表示您同意接受本使用条款（以下简称“本条款”）的约束。如您不同意本条款的全部内容，请勿访问或使用本服务。
      </p>
      <p>
        我们可能会不定期更新本条款。在条款变更后继续使用本服务，即视为您接受修订后的条款。建议您定期查阅本条款。
      </p>

      <h2>二、服务说明</h2>
      <p>
        LectureLive 是一个面向学术和教育场景的网页平台，提供以下核心功能：
      </p>
      <ul>
        <li><strong>实时课堂转录</strong> —— 基于自动语音识别（ASR）技术，将课堂语音实时转换为文字；</li>
        <li><strong>实时翻译</strong> —— 将转录内容翻译为多种语言；</li>
        <li><strong>AI 智能摘要</strong> —— 利用人工智能生成课堂摘要及关键词提取；</li>
        <li><strong>协作共享</strong> —— 与其他用户共享实时转录会话；</li>
        <li><strong>会话录制与导出</strong> —— 支持 JSON、Markdown、SRT、TXT 等多种格式导出。</li>
      </ul>
      <p>
        上述功能的可用性和准确性可能受网络状况、音频质量、语言支持范围及第三方服务可用性等因素影响。
      </p>

      <h2>三、用户账户</h2>
      <h3>3.1 注册</h3>
      <p>
        使用本服务的部分功能需要注册账户。注册时需提供有效的电子邮件地址、显示名称和安全密码。您保证所提供的注册信息真实、准确、完整。
      </p>
      <h3>3.2 账户安全</h3>
      <p>
        您有责任妥善保管账户凭证的机密性，并对通过您账户发生的所有活动负责。如发现任何未经授权的账户使用行为，请立即通知我们。因未经授权的账户访问所造成的任何损失，LectureLive 不承担责任。
      </p>
      <h3>3.3 账户责任</h3>
      <p>
        您对通过账户上传、转录或生成的所有内容承担全部责任。您不得将账户凭证分享给第三方，也不得允许他人通过您的账户访问本服务。
      </p>

      <h2>四、合理使用</h2>
      <p>您同意仅将本服务用于合法目的。您不得：</p>
      <ul>
        <li>未经所有发言者或参与者同意，使用本服务转录、录制或传播内容；</li>
        <li>上传或传输侵犯任何第三方知识产权的材料；</li>
        <li>尝试对本服务的任何部分进行逆向工程、反编译或反汇编；</li>
        <li>未经事先书面同意，使用自动化工具、机器人或爬虫程序访问本服务；</li>
        <li>干扰或破坏本服务的完整性或正常运行；</li>
        <li>利用本服务骚扰、诽谤或威胁任何个人；</li>
        <li>传输任何病毒、恶意软件或其他有害代码；</li>
        <li>违反任何适用的地方、州、国家或国际法律法规。</li>
      </ul>
      <p>
        如我们合理认为您违反了本条款，我们有权暂停或终止您的账户。
      </p>

      <h2>五、知识产权</h2>
      <h3>5.1 用户内容</h3>
      <p>
        您保留通过本服务上传、创建或生成的所有内容的所有权，包括音频录音、转录文本和笔记。使用本服务即表示您授予 LectureLive 有限的、非排他性的许可，仅用于为您提供本服务之目的处理您的内容。
      </p>
      <h3>5.2 平台知识产权</h3>
      <p>
        本服务及其设计、代码、算法、用户界面、商标和文档均为 LectureLive 的知识产权，受著作权法及其他知识产权法律保护。未经我们事先书面同意，您不得复制、修改、分发本服务或基于本服务创作衍生作品。
      </p>

      <h2>六、隐私保护</h2>
      <p>
        您对本服务的使用同时受我们的<a href="/privacy">隐私政策</a>约束，该政策描述了我们如何收集、使用和保护您的个人信息。使用本服务即表示您同意隐私政策中所述的做法。
      </p>

      <h2>七、第三方服务</h2>
      <p>
        为实现核心功能，LectureLive 集成了以下第三方服务：
      </p>
      <ul>
        <li><strong>Soniox</strong> —— 提供自动语音识别（ASR）服务。音频数据将传输至 Soniox 服务器进行实时转录处理。</li>
        <li><strong>大语言模型（LLM）提供商</strong> —— 包括 Anthropic（Claude）、OpenAI（GPT）和 DeepSeek。转录文本可能发送至上述服务，用于 AI 摘要生成、关键词提取及翻译。</li>
      </ul>
      <p>
        上述第三方服务受其各自的服务条款和隐私政策约束。LectureLive 不控制也不对第三方提供商的做法承担责任。建议您查阅相关服务的政策条款。
      </p>

      <h2>八、数据存储与保留</h2>
      <p>
        会话数据、转录内容和录音文件存储在本地或可选的云存储服务（Cloudreve）中，存储空间受用户配额限制。LectureLive 不保证无限期保留您的数据，建议您定期导出重要内容。
      </p>
      <p>
        您可随时通过本服务删除您的数据。账户注销后，所有相关数据将按照隐私政策的规定永久删除。
      </p>

      <h2>九、免责声明</h2>
      <p>
        本服务按“现状”和“可用”基础提供，不提供任何明示或暗示的保证，包括但不限于对适销性、特定用途适用性和非侵权性的暗示保证。
      </p>
      <p>
        LectureLive 不保证：（a）本服务将不间断、及时、安全或无差错地运行；（b）转录内容准确或完整；（c）AI 生成的摘要不含错误或遗漏；（d）本服务能满足您的特定需求。
      </p>

      <h2>十、责任限制</h2>
      <p>
        在适用法律允许的最大范围内，LectureLive 及其董事、管理人员、员工和代理人不对因您使用或无法使用本服务而产生的或与之相关的任何间接、附带、特殊、后果性或惩罚性损害承担责任，包括但不限于数据丢失、利润损失或声誉损害，即使 LectureLive 已被告知此类损害的可能性。
      </p>
      <p>
        在任何情况下，LectureLive 因本条款或本服务引起的或与之相关的所有索赔的总责任不超过您在索赔前十二（12）个月内向 LectureLive 支付的金额或一百美元（US$100），以较高者为准。
      </p>

      <h2>十一、条款变更</h2>
      <p>
        LectureLive 保留随时修改本条款的权利。对于重大变更，我们将通过在本服务上发布通知或向您的注册邮箱发送电子邮件的方式通知注册用户。除另有说明外，变更自发布之日起生效。变更发布后继续使用本服务即视为您接受修改后的条款。
      </p>

      <h2>十二、适用法律</h2>
      <p>
        本条款应受美国加利福尼亚州法律管辖并依其解释，不考虑其法律冲突条款。因本条款或本服务引起的或与之相关的任何争议，应由加利福尼亚州旧金山县的州法院或联邦法院专属管辖。
      </p>

      <h2>十三、联系方式</h2>
      <p>
        如您对本使用条款有任何疑问或意见，请通过以下方式联系我们：
      </p>
      <p>
        <strong>电子邮件：</strong>{' '}
        <a href="mailto:support@lecturelive.com">support@lecturelive.com</a>
      </p>
    </article>
  );
}
