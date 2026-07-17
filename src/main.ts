import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  const port = parseInt(process.env.PORT || '80', 10);
  await app.listen(port, '0.0.0.0');
  new Logger('main').log(`秒聘服务 HTTP 就绪 :${port} · webhook=/feishu/webhook`);
}
bootstrap();
