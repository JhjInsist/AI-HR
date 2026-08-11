import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConfigService } from '../config/config.service';

/** 侧边栏会话载荷(自签,不外传) */
export interface SidebarSession {
  orgId: string;
  uid: string;
  botId?: string;
  wxUserId?: string;
  name?: string;
  exp: number;                   // 毫秒时间戳
}

/**
 * 聚合聊天侧边栏入口鉴权。
 *
 * 为什么这样做:card/resume 返回候选人手机号、时间线、简历,不能裸奔。而侧边栏页面跑在
 * 用户浏览器里,任何下发到浏览器的共享密钥都等于公开,所以不能用「前端带 token」的方案。
 *
 * 可验证的凭据只有一个:宿主签发的 OAuth code。它只能由登录态的聚合聊天工作台取得
 * (xiaoju-bot-api `/oauth/getOAuthCode` 挂了 auth 中间件),且 identity-service 侧
 * `RedeemCode` 是 Mongo `FindOneAndUpdate({_id, used:false}, {used:true})` 的**原子一次性**消费。
 * 因此「持有一个未使用的新鲜 code」可作为「本次请求来自真实侧边栏会话」的证据。
 *
 * 流程:浏览器把 code POST 给本服务 → **服务端**拿 code 去 BFF 换身份 → 校验 orgId 白名单
 * → 签发本服务自己的短时会话令牌(HMAC)→ 后续 card/resume 只认该令牌。
 * code 一次性,所以只在建会话时兑换一次,不能每请求都 redeem。
 *
 * fail-closed:BFF 地址或签名密钥未配置时,`enabled()` 为假,建会话与校验一律拒绝 ——
 * 宁可功能不可用,也不退化成放行。
 */
@Injectable()
export class SidebarAuthService {
  private readonly logger = new Logger(SidebarAuthService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * OAuth 兑换服务的基址。填聚合聊天控制台公网域名(官方文档口径),或内网 bff 地址。
   * 两者的路径前缀不同,见 oauthPath()。
   */
  private bffBase(): string {
    return (this.config.get('SIDEBAR_OAUTH_BASE') || '').trim().replace(/\/$/, '');
  }

  /**
   * 兑换接口路径。默认用官方文档的公网口径 `/api/v1/oauth/getUserInfo`
   * (文档 https://s.apifox.cn/d292e311-af7c-4a68-bfe4-416fd1d657b6/6951436m0)。
   *
   * 注意:xiaoju-bff 里的实际路由是 `@Get('/v1/oauth/getUserInfo')`(无 /api),
   * `/api` 由网关加。所以若 SIDEBAR_OAUTH_BASE 直连内网 bff,需把本项覆盖为
   * `/v1/oauth/getUserInfo`,否则会 404。做成可配是因为两种部署都合法,
   * 硬编码任一种都会在另一种下静默失败。
   */
  private oauthPath(): string {
    const p = (this.config.get('SIDEBAR_OAUTH_PATH') || '/api/v1/oauth/getUserInfo').trim();
    return p.startsWith('/') ? p : `/${p}`;
  }

  private secret(): string {
    return (this.config.get('SIDEBAR_SESSION_SECRET') || '').trim();
  }

  /** 会话有效期(秒),默认 30 分钟。解析不出按 0 处理(立即过期,偏保守)。 */
  private ttlSec(): number {
    const n = parseInt(this.config.get('SIDEBAR_SESSION_TTL_SEC', '1800'), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** 允许的 orgId 白名单;为空表示不限 org(单租户部署常态),但 code 仍须有效。 */
  private orgWhitelist(): string[] {
    return (this.config.get('SIDEBAR_ORG_WHITELIST') || '')
      .split(',').map((x) => x.trim()).filter(Boolean);
  }

  /** 鉴权是否已就绪。false 时所有侧边栏接口必须拒绝服务。 */
  enabled(): boolean {
    return !!this.bffBase() && !!this.secret();
  }

  /**
   * 用宿主签发的 OAuth code 换本服务会话。
   * 失败(code 无效/过期/已用、org 不在白名单、BFF 异常、未配置)一律返回 null,绝不放行。
   */
  async createSession(code?: string): Promise<{ token: string; expiresIn: number } | null> {
    if (!this.enabled()) {
      this.logger.warn('[侧边栏鉴权] 未配置 SIDEBAR_OAUTH_BASE / SIDEBAR_SESSION_SECRET,拒绝建会话');
      return null;
    }
    const c = (code || '').toString().trim();
    if (!c) return null;
    try {
      const { data } = await axios.get(`${this.bffBase()}${this.oauthPath()}`, {
        params: { code: c }, timeout: 5000,
      });
      // BFF 用 errcode 表达失败:-1 无效/已消费、-2 过期、-4 缺 code
      if (!data || data.errcode !== 0) {
        this.logger.warn(`[侧边栏鉴权] code 兑换失败 errcode=${data?.errcode} ${data?.errmsg || ''}`);
        return null;
      }
      const d = data.data || {};
      const orgId = (d.orgId || '').toString();
      const wl = this.orgWhitelist();
      if (wl.length && !wl.includes(orgId)) {
        this.logger.warn(`[侧边栏鉴权] orgId=${orgId} 不在白名单,拒绝`);
        return null;
      }
      const ttl = this.ttlSec();
      const payload: SidebarSession = {
        orgId,
        uid: (d.uid || '').toString(),
        botId: (d.botId || '').toString(),
        wxUserId: (d.userId || '').toString(),
        name: d.name || '',
        exp: Date.now() + ttl * 1000,
      };
      this.logger.log(`[侧边栏鉴权] 会话签发 org=${orgId} uid=${payload.uid} ttl=${ttl}s`);
      return { token: this.sign(payload), expiresIn: ttl };
    } catch (e: any) {
      this.logger.error(`[侧边栏鉴权] 兑换异常: ${e?.message}`);
      return null;
    }
  }

  /** 校验会话令牌。任何异常/篡改/过期/未配置一律返回 null。 */
  verify(token?: string): SidebarSession | null {
    if (!this.enabled()) return null;
    const t = (token || '').toString().trim();
    const i = t.indexOf('.');
    if (i <= 0 || i === t.length - 1) return null;
    const body = t.slice(0, i);
    const sig = t.slice(i + 1);
    const expect = createHmac('sha256', this.secret()).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!p || typeof p.exp !== 'number' || Date.now() > p.exp) return null;
      return p as SidebarSession;
    } catch {
      return null;
    }
  }

  private sign(p: SidebarSession): string {
    const body = Buffer.from(JSON.stringify(p)).toString('base64url');
    const sig = createHmac('sha256', this.secret()).update(body).digest('base64url');
    return `${body}.${sig}`;
  }
}
