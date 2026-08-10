import { Controller, Get, Post, Body, Query, Res, Headers, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '../config/config.service';
import { ConverseService } from '../recruit/converse.service';
import { MiaohuiService } from '../miaohui/miaohui.service';
import { ReachService } from '../reach/reach.service';
import { SidebarAuthService } from './sidebar-auth.service';
import { SIDEBAR_HTML } from './sidebar.page';

/**
 * 逻辑层辅助 API（已去表格化，不碰飞书多维表格）。
 * 主路径是 /reach + /mh/callback（触达服务主导对话）；这里保留纯加好友与对话测试端点。
 */
@Controller('logic')
export class LogicController {
  constructor(
    private readonly config: ConfigService,
    private readonly converse: ConverseService,
    private readonly miaohui: MiaohuiService,
    private readonly reachSvc: ReachService,
    private readonly sidebarAuth: SidebarAuthService,
  ) {}

  /** 发起纯加好友：POST /logic/reach {phone, name?, helloMsg?}（不建任务、不走编排，仅加好友） */
  @Post('reach')
  async reach(@Body() body: { phone?: string; name?: string; helloMsg?: string }) {
    const phone = (body?.phone || '').trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) return { ok: false, code: -1, msg: '缺少或非法手机号 phone' };
    const hello = body?.helloMsg || this.config.get('HELLO_MSG', '你好，我是句子互动招聘助理，看到你投递的简历，想加你了解一下~');
    const res = await this.miaohui.addFriendByPhone(phone, hello);
    return { ok: res.ok, code: res.code, name: body?.name || '', phone };
  }

  /** 对话测试：GET /logic/converse?text= → 大模型意图分类 + 话术（不落库，仅供调试） */
  @Get('converse')
  async converseApi(@Query('text') text: string) {
    const q = (text || '').trim();
    if (!q) return { reply: '在的，请问有什么可以帮您？', intent: 'OTHER', action: 'fallback', time: '' };
    const r = await this.converse.handle(q);
    return { reply: r.reply, intent: r.intent, action: r.action, time: r.time || '' };
  }

  /** 查约面信息：GET /logic/candidate-info?phone=[&externalId=] → {found, name, position, interviewTime, welcome} */
  @Get('candidate-info')
  async candidateInfo(@Query('phone') phone: string, @Query('externalId') externalId?: string) {
    const p = (phone || '').trim();
    if (!p) return { found: false, msg: '缺少 phone' };
    return this.reachSvc.getCandidateInfo(p, externalId);
  }

  /**
   * 侧边栏候选人卡片（纯读，无副作用）：
   * GET /logic/candidate-card?externalUserId=[&wxid=&chatId=&phone=]
   * 聚合聊天侧边栏按会话上下文的任一标识命中，返回姓名/岗位/面试官/轮次/状态/时间线等。
   * 与 candidate-info 区分：此接口绝不推进状态机、不发欢迎语、不写库。
   */
  @Get('candidate-card')
  async candidateCard(
    @Headers('x-sidebar-session') session?: string,
    @Query('externalUserId') externalUserId?: string,
    @Query('wxid') wxid?: string,
    @Query('chatId') chatId?: string,
    @Query('phone') phone?: string,
  ) {
    // 返回手机号/时间线,必须持有本服务签发的会话(未配置鉴权时 verify 恒 false → fail closed)
    if (!this.sidebarAuth.verify(session)) {
      throw new UnauthorizedException('侧边栏会话无效或已过期');
    }
    return this.reachSvc.getCandidateCard({ externalUserId, wxid, chatId, phone });
  }

  /**
   * 建侧边栏会话：POST /logic/sidebar-session {code}
   * code 是宿主签发的一次性 OAuth code（只有登录态聚合聊天能取得）。**服务端**拿它去 BFF
   * 换身份，校验 orgId 白名单后签发本服务的短时会话令牌；共享密钥不下发浏览器。
   * code 在 identity-service 侧是原子一次性消费，故只在建会话时换一次。
   */
  @Post('sidebar-session')
  async sidebarSession(@Res() res: Response, @Body() body?: { code?: string }) {
    const r = await this.sidebarAuth.createSession(body?.code);
    if (!r) {
      res.status(401).json({ ok: false, msg: '身份校验失败：code 无效/已过期，或侧边栏鉴权未配置' });
      return;
    }
    res.json({ ok: true, token: r.token, expiresIn: r.expiresIn });
  }

  /**
   * 聚合聊天侧边栏页面：GET /logic/sidebar
   * 注册到「企业控制台 → 配置中心 → 工具栏配置」。建议 URL 带 msgType=postMessage
   * 走 JS-SDK 版（能拿到 externalUserId，命中率最高，且切会话时宿主会推 updateBaseInfo）。
   */
  @Get('sidebar')
  sidebarPage(@Res() res: Response) {
    // 禁用缓存：同 admin 配置台，避免 iframe 用旧 JS（相对 fetch 路径 bug 曾因此复现）
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.type('html').send(SIDEBAR_HTML);
  }

  /**
   * 简历附件代理：GET /logic/candidate-resume?dataId=[&phone=]
   * 表格服务的 /candidate/resume 要求 X-AIHR-Token 头，浏览器 <a href> 带不了，
   * 故由本服务代理转发（token 只留在服务端）。侧边栏卡片的 resumeUrl 指向这里。
   */
  @Get('candidate-resume')
  async candidateResume(
    @Res() res: Response,
    @Headers('x-sidebar-session') session?: string,
    @Query('dataId') dataId?: string,
    @Query('phone') phone?: string,
  ) {
    // 同 candidate-card：下载简历必须持有会话。页面侧用 fetch+blob 带头请求，不把令牌塞 URL。
    if (!this.sidebarAuth.verify(session)) {
      res.status(401).json({ ok: false, msg: '侧边栏会话无效或已过期' });
      return;
    }
    const r = await this.reachSvc.getCandidateResume({ dataId, phone });
    if (!r) {
      res.status(404).json({ ok: false, msg: '无简历附件或表格服务不可用' });
      return;
    }
    // 简历不一定是 PDF（也有 docx），按扩展名给类型，未知则交给浏览器下载
    const ext = (r.name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
    const mime = {
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    }[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(r.name)}`);
    res.send(r.data);
  }

  /** 意图回报（兼容旧画布链路）：POST /logic/report-intent {externalId|contactId|phone, intent, slots?} */
  @Post('report-intent')
  async reportIntent(@Body() body: { externalId?: string; contactId?: string; phone?: string; intent?: string; slots?: Record<string, any> }) {
    const id = (body?.externalId || body?.contactId || body?.phone || '').trim();
    const intent = (body?.intent || '').trim();
    if (!id || !intent) return { ok: false, msg: '缺少 externalId/contactId 或 intent' };
    return this.reachSvc.reportIntent(id, intent, body?.slots);
  }
}
