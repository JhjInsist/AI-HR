import { Controller, Get, Post, Body, Res } from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '../config/config.service';
import { InsightAdminService, MODEL_GROUPS } from './insight-admin.service';
import { ADMIN_HTML } from './admin.page';

/**
 * 配置台：可视化配置表格/Agent/触达/秒回，无需重新部署。
 * 暂不鉴权（内部用），后续接飞书登录。
 */
@Controller('admin')
export class AdminController {
  constructor(private readonly config: ConfigService, private readonly insight: InsightAdminService) {}

  @Get()
  page(@Res() res: Response) {
    res.type('html').send(ADMIN_HTML);
  }

  @Get('config')
  getConfig() {
    return { config: this.config.all(), models: MODEL_GROUPS };
  }

  @Post('config')
  save(@Body() body: Record<string, any>) {
    return { ok: true, config: this.config.save(body || {}) };
  }

  /** 切换 Agent 模型：重建意图+对话两个秒懂画布 */
  @Post('model')
  async setModel(@Body() body: { model?: string }) {
    if (!body?.model) return { ok: false, msg: '缺 model' };
    try {
      const r = await this.insight.setModel(body.model);
      return { ok: true, msg: `已切换到 ${body.model}`, ...r };
    } catch (e: any) {
      return { ok: false, msg: e?.message || '切换失败' };
    }
  }
}
