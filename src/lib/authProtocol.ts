/** 浏览器 logout 用这个绑定头证明请求仍针对其发起时的 token family。 */
export const AUTH_SESSION_BINDING_HEADER = 'X-Lecture-Live-Auth-Session';

/** 浏览器内仅保存非授权哨兵；真实 JWT 只能存在于 HttpOnly cookie。 */
export const CLIENT_SESSION_TOKEN = '__cookie_session__';
