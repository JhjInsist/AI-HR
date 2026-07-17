import { Module } from '@nestjs/common';
import { ConfigService } from './config/config.service';
import { FeishuService } from './feishu/feishu.service';
import { FeishuController } from './feishu/feishu.controller';
import { MiaohuiService } from './miaohui/miaohui.service';
import { ContactService } from './recruit/contact.service';
import { RecruitService } from './recruit/recruit.service';
import { RecruitScheduler } from './recruit/recruit.scheduler';
import { BotService } from './bot/bot.service';
import { MiaodongService } from './miaodong/miaodong.service';
import { ConverseService } from './recruit/converse.service';
import { AdminController } from './admin/admin.controller';
import { InsightAdminService } from './admin/insight-admin.service';
import { LogicController } from './logic/logic.controller';

@Module({
  controllers: [FeishuController, AdminController, LogicController],
  providers: [
    ConfigService, FeishuService, MiaohuiService, ContactService, RecruitService,
    RecruitScheduler, BotService, MiaodongService, ConverseService, InsightAdminService,
  ],
})
export class AppModule {}
