import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { ReachService } from './reach/reach.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  const port = parseInt(process.env.PORT || '80', 10);
  await app.listen(port, '0.0.0.0');
  new Logger('main').log(`秒聘服务 HTTP 就绪 :${port} · webhook=/feishu/webhook`);
  // 定时扫描:邀约沉默24h转人工 / 改期拖延每日回访(30分钟一轮)
  const reach = app.get(ReachService);
  setInterval(() => reach.sweepIdle().catch((e) => new Logger('sweep').error(e?.message)), 30 * 60 * 1000);
  // 好友通过后的欢迎语补偿：直接发送失败时每10秒重试，服务重启后也会从 Mongo 恢复。
  reach.sweepWelcomePending().catch((e) => new Logger('welcome-sweep').error(e?.message));
  setInterval(() => reach.sweepWelcomePending().catch((e) => new Logger('welcome-sweep').error(e?.message)), 10 * 1000);
}
bootstrap();
