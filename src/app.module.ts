import { Module } from '@nestjs/common';
import { ConfigService } from './config/config.service';
import { FeishuService } from './feishu/feishu.service';
import { FeishuController } from './feishu/feishu.controller';
import { MiaohuiService } from './miaohui/miaohui.service';
import { BotService } from './bot/bot.service';
import { MiaodongService } from './miaodong/miaodong.service';
import { ConverseService } from './recruit/converse.service';
import { AdminController } from './admin/admin.controller';
import { InsightAdminService } from './admin/insight-admin.service';
import { LogicController } from './logic/logic.controller';

// 注：表格管理（AI-HR表→进度表同步、字段监听触达、简历OCR、定时轮询）已拆分为独立服务，
// 见 recruit/ 目录曾有的 recruit.service/contact.service/recruit.scheduler（已移除）。
// 本服务只保留：触达对话大脑(converse/miaodong)、秒回加好友(miaohui)、
// 秒懂画布回调逻辑(logic)、飞书群运维助手(bot)、配置台(admin)。
@Module({
  controllers: [FeishuController, AdminController, LogicController],
  providers: [
    ConfigService, FeishuService, MiaohuiService, BotService,
    MiaodongService, ConverseService, InsightAdminService,
  ],
})
export class AppModule {}
