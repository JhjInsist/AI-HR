import { Controller, Post, Body, Res } from '@nestjs/common';
import { Response } from 'express';
import { ReachService, CreateReachDto } from './reach.service';

/**
 * 触达编排入口。
 * - POST /reach          表格服务发起触达（建任务 + 秒回加好友）
 * - POST /mh/callback     秒回统一回调入口（先回 200 再异步分发，避免地址被禁）
 */
@Controller()
export class ReachController {
  constructor(private readonly reachSvc: ReachService) {}

  /** 发起触达 */
  @Post('reach')
  async reach(@Body() body: CreateReachDto) {
    return this.reachSvc.createTask(body || ({} as CreateReachDto));
  }

  /** 秒回统一回调：先 res 200，再异步 handleCallback（回调必须 200+异步+幂等） */
  @Post('mh/callback')
  async callback(@Body() body: any, @Res() res: Response) {
    res.json({ code: 0 });
    setImmediate(() => { this.reachSvc.handleCallback(body); });
  }
}
