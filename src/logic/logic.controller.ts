import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { ConverseService } from '../recruit/converse.service';
import { MiaohuiService } from '../miaohui/miaohui.service';
import { ReachService } from '../reach/reach.service';

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

  /** 意图回报（兼容旧画布链路）：POST /logic/report-intent {externalId|contactId|phone, intent, slots?} */
  @Post('report-intent')
  async reportIntent(@Body() body: { externalId?: string; contactId?: string; phone?: string; intent?: string; slots?: Record<string, any> }) {
    const id = (body?.externalId || body?.contactId || body?.phone || '').trim();
    const intent = (body?.intent || '').trim();
    if (!id || !intent) return { ok: false, msg: '缺少 externalId/contactId 或 intent' };
    return this.reachSvc.reportIntent(id, intent, body?.slots);
  }
}
