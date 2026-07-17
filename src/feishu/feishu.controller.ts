import { Controller, Post, Get, Body, Res, Query } from '@nestjs/common';
import { Response } from 'express';
import { Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { FeishuService } from './feishu.service';
import { BotService } from '../bot/bot.service';
import { MiaodongService } from '../miaodong/miaodong.service';
import { ConverseService } from '../recruit/converse.service';
import { RecruitService } from '../recruit/recruit.service';
import { ConfigService } from '../config/config.service';

/**
 * 飞书事件回调 + 健康检查。
 * 事件 URL 配到开放平台：https://ai-hr.juzibot.com/feishu/webhook
 */
@Controller('feishu')
export class FeishuController {
  private readonly logger = new Logger(FeishuController.name);
  private readonly ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY || '';
  private readonly seen = new Set<string>(); // 事件去重(飞书会重推)

  constructor(
    private readonly feishu: FeishuService,
    private readonly bot: BotService,
    private readonly miaodong: MiaodongService,
    private readonly converse: ConverseService,
    private readonly recruit: RecruitService,
    private readonly config: ConfigService,
  ) {}

  @Get('health')
  health() {
    return { ok: true, service: 'miaopin-service', ts: Date.now() };
  }

  @Get('intent')
  async intent(@Query('text') text: string) {
    if (!text) return { note: '用 ?text=候选人回复 测试意图识别' };
    return this.miaodong.classify(text);
  }

  /** 触达对话全链路测试：意图分类 + 死规则路由 + 知识库应答（?candidate= 传名字才会写进度表） */
  @Get('converse')
  async converseTest(@Query('text') text: string, @Query('candidate') candidate?: string) {
    if (!text) return { note: '用 ?text=候选人回复[&candidate=姓名] 测试触达对话' };
    return this.converse.handle(text, candidate);
  }

  /** 手动触发规则②触达。?live=1 强制真跑(覆盖DRY_RUN)，?name=姓名 只触达某一人。运维/小范围验证用 */
  @Get('reach')
  async reach(@Query('live') live?: string, @Query('name') name?: string) {
    return this.recruit.rule2_reachOut({ live: live === '1', onlyName: name || undefined });
  }

  @Post('webhook')
  async webhook(@Body() body: any, @Res() res: Response) {
    let payload = body;
    // 若开启加密，解密
    if (this.ENCRYPT_KEY && body?.encrypt) {
      payload = JSON.parse(this.decrypt(body.encrypt));
    }
    // URL 校验
    if (payload?.type === 'url_verification') {
      return res.json({ challenge: payload.challenge });
    }
    res.json({ code: 0 }); // 先回 200，异步处理

    try {
      const header = payload?.header || {};
      const eventId = header.event_id;
      if (eventId && this.seen.has(eventId)) return;
      if (eventId) { this.seen.add(eventId); if (this.seen.size > 5000) this.seen.clear(); }

      const type = header.event_type || payload?.event?.type;
      if (type === 'im.message.receive_v1') {
        await this.onMessage(payload.event);
      }
    } catch (e: any) {
      this.logger.error(`处理事件异常: ${e?.message}`);
    }
  }

  /** 消息里是否明确 @ 到机器人本人 */
  private mentionsBot(msg: any): boolean {
    const botName = this.config.get('FEISHU_BOT_NAME', '秒聘').replace(/\s/g, '');
    return (msg.mentions || []).some((m: any) => (m?.name || '').replace(/\s/g, '').includes(botName));
  }

  private async onMessage(event: any) {
    const msg = event?.message || {};
    const chatId = msg.chat_id;
    if (msg.message_type !== 'text') return;
    // 只响应"明确 @机器人本人"的消息：群里 @秒聘 才回；单聊、群里@别人一律忽略
    if (!this.mentionsBot(msg)) return;
    let text = '';
    try { text = JSON.parse(msg.content).text || ''; } catch {}
    this.logger.log(`[收到] chat=${msg.chat_type} text="${text.replace(/@[^\s]+/g, '').trim()}"`);
    const reply = await this.bot.handle(text);
    this.logger.log(`[回复] "${(reply || '').slice(0, 60)}..."`);
    if (reply && chatId) await this.feishu.sendText(chatId, reply);
  }

  private decrypt(encrypt: string): string {
    const key = crypto.createHash('sha256').update(this.ENCRYPT_KEY).digest();
    const data = Buffer.from(encrypt, 'base64');
    const iv = data.subarray(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let out = decipher.update(data.subarray(16));
    out = Buffer.concat([out, decipher.final()]);
    return out.toString('utf8');
  }
}
