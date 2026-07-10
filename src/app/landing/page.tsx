import { redirect } from 'next/navigation';

// 首页（落地页）现在就是根路由 `/`。保留 `/landing` 作为兼容别名，永久重定向到根，
// 避免重复内容与两套渲染。
export default function LegacyLandingPage() {
  redirect('/');
}
