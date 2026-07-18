import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import Redis from 'ioredis';
import { ConfigService } from './config/config.service';
import { FeishuService } from './feishu/feishu.service';
import { FeishuController } from './feishu/feishu.controller';
import { MiaohuiService } from './miaohui/miaohui.service';
import { ConverseService } from './recruit/converse.service';
import { AdminController } from './admin/admin.controller';
import { InsightAdminService } from './admin/insight-admin.service';
import { LogicController } from './logic/logic.controller';
import { ReachController } from './reach/reach.controller';
import { ReachService } from './reach/reach.service';
import { ReachTask, ReachTaskSchema } from './reach/reach.schema';
import { REACH_REDIS } from './reach/reach.module';
import { AppConfigItem, AppConfigSchema } from './config/config.schema';
import { HrMapping, HrMappingSchema } from './hr/hr.schema';
import { HrService } from './hr/hr.service';
import { LlmService } from './llm/llm.service';
import { TableService } from './table/table.service';

// ioredis provider（触达编排幂等锁）：lazyConnect 首连失败不崩，锁异常时放行不阻断业务
const redisProvider = {
  provide: REACH_REDIS,
  useFactory: () => new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 2 }),
};

// 注：表格管理（AI-HR表→进度表同步、字段监听、简历OCR、轮询）已拆分为独立服务。
// 本服务保留：触达对话大脑(converse/miaodong)、秒回加好友(miaohui)、
// 触达编排状态机(reach)、秒懂画布回调逻辑(logic)、飞书群运维(bot)、配置台(admin)。
// 采用扁平结构（所有 provider 在 AppModule）避免 NestJS 模块隔离带来的循环依赖。
@Module({
  imports: [
    MongooseModule.forRoot(process.env.MONGO_URI || 'mongodb://localhost:27017/aihr'),
    MongooseModule.forFeature([
      { name: ReachTask.name, schema: ReachTaskSchema },
      { name: AppConfigItem.name, schema: AppConfigSchema },
      { name: HrMapping.name, schema: HrMappingSchema },
    ]),
  ],
  controllers: [FeishuController, AdminController, LogicController, ReachController],
  providers: [
    ConfigService, FeishuService, MiaohuiService,
    ConverseService, InsightAdminService,
    ReachService, HrService, LlmService, TableService, redisProvider,
  ],
})
export class AppModule {}
