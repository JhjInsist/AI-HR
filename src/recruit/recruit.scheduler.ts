import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RecruitService } from './recruit.service';

/** 定时轮询两张表，跑两条确定性规则。轮询间隔 POLL_INTERVAL_SEC。 */
@Injectable()
export class RecruitScheduler implements OnModuleInit {
  private readonly logger = new Logger(RecruitScheduler.name);
  private running = false;

  constructor(private readonly recruit: RecruitService) {}

  onModuleInit() {
    const sec = parseInt(process.env.POLL_INTERVAL_SEC || '60', 10);
    this.logger.log(`秒聘服务启动 · 轮询间隔 ${sec}s · DRY_RUN=${process.env.DRY_RUN !== 'false'}`);
    this.tick();
    setInterval(() => this.tick(), sec * 1000);
  }

  private async tick() {
    if (this.running) return; // 幂等：上一轮没跑完不叠加
    this.running = true;
    try {
      await this.recruit.rule1_intakeToProgress();
      await this.recruit.rule2_reachOut();
    } catch (e: any) {
      this.logger.error(`轮询异常: ${e?.message}`);
    } finally {
      this.running = false;
    }
  }
}
