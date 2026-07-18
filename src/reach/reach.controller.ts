import { Controller, Post, Body, Res } from '@nestjs/common';
import { Response } from 'express';
import { ReachService, CreateReachDto } from './reach.service';

/**
 * 触达编排入口。
 * - POST /reach          表格服务发起触达（建任务 + 秒回加好友）
 * - POST /handover        表格服务同步【转人工】开关（AI 是否接待此对话）
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

  /** 改期直推：表格服务在面试时间被改后调用 → {dataId?|phone?, interviewTime, round?} */
  @Post('notify')
  async notify(@Body() body: { dataId?: string; phone?: string; interviewTime?: string; round?: string }) {
    return this.reachSvc.notifyTimeChange((body?.dataId || '').trim(), (body?.phone || '').trim(),
      (body?.interviewTime || '').toString(), body?.round);
  }

  /** 反向转人工：表格服务同步进度表【转人工】开关（HR 手动勾选/取消）→ {dataId, handover} */
  @Post('handover')
  async handover(@Body() body: { dataId?: string; handover?: boolean }) {
    return this.reachSvc.setHandover((body?.dataId || '').trim(), body?.handover === true);
  }

  /**
   * 秒回统一回调：秒回把配置的回调地址当 base，往后拼子路径推送
   * （base 本身、/message 接收消息、/friend/confirm 好友通过、/friend/send 加好友结果、
   *  /sentResult 发送结果、/chat 会话事件等）。故 base 及所有子路径都进同一处理器，
   *  按 body 字段分发。先 res 200，再异步处理（回调必须 200+异步+幂等）。
   */
  @Post('mh/callback')
  async callback(@Body() body: any, @Res() res: Response) {
    res.json({ code: 0 });
    setImmediate(() => { this.reachSvc.handleCallback(body); });
  }

  @Post('mh/callback/*')
  async callbackSub(@Body() body: any, @Res() res: Response) {
    res.json({ code: 0 });
    setImmediate(() => { this.reachSvc.handleCallback(body); });
  }
}
