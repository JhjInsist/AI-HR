import { Controller, Post, Get, Body, Res, Query } from '@nestjs/common';
import { Response } from 'express';
import { Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { ConverseService } from '../recruit/converse.service';

/**
 * 飞书事件订阅校验 + 健康检查 + 对话测试。
 * 去表格化后：飞书群 @机器人「查进度/加微信」等运维交给表格服务，本服务不再处理群消息事件。
 */
@Controller('feishu')
export class FeishuController {
  private readonly logger = new Logger(FeishuController.name);
  private readonly ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY || '';

  constructor(private readonly converse: ConverseService) {}

  @Get('health')
  health() {
    return { ok: true, service: 'miaopin-service', ts: Date.now() };
  }

  /** 对话测试：GET /feishu/converse?text= → 大模型意图分类 + 话术（不落库） */
  @Get('converse')
  async converseTest(@Query('text') text: string) {
    if (!text) return { note: '用 ?text=候选人回复 测试触达对话' };
    return this.converse.handle(text);
  }

  /** 飞书事件订阅：仅保留 url_verification 校验；消息事件不再处理（飞书群运维归表格服务） */
  @Post('webhook')
  async webhook(@Body() body: any, @Res() res: Response) {
    let payload = body;
    if (this.ENCRYPT_KEY && body?.encrypt) {
      try { payload = JSON.parse(this.decrypt(body.encrypt)); } catch { /* ignore */ }
    }
    if (payload?.type === 'url_verification') {
      return res.json({ challenge: payload.challenge });
    }
    res.json({ code: 0 });
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
