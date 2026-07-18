import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/** 触达任务状态机（方案第五节） */
export enum ReachStatus {
  PENDING = 'PENDING',                 // 初始
  ADDING = 'ADDING',                   // 已发起加好友
  ADD_FAILED = 'ADD_FAILED',           // 加好友失败
  CONFIRMED = 'CONFIRMED',             // 好友已通过
  WELCOMED = 'WELCOMED',               // 欢迎语已发
  REPLIED = 'REPLIED',                 // 候选人已回复
  INTENT_ACCEPT = 'INTENT_ACCEPT',     // 确认约面
  INTENT_RESCHEDULE = 'INTENT_RESCHEDULE', // 改约
  INTENT_REJECT = 'INTENT_REJECT',     // 拒绝
  INTENT_QUESTION = 'INTENT_QUESTION', // 提问（不改主状态）
  HANDOVER = 'HANDOVER',               // 转人工
  REMIND_HR = 'REMIND_HR',             // 超时提醒HR
}

/** 时间线一条留痕 */
export interface TimelineEntry {
  at: Date;
  event: string;
  detail?: string;
}

export type ReachTaskDocument = HydratedDocument<ReachTask>;

/** 触达任务（MongoDB `aihr.reach_tasks`，方案第六节） */
@Schema({ collection: 'reach_tasks', timestamps: true })
export class ReachTask {
  @Prop({ required: true, unique: true, index: true })
  taskId: string;                      // 作 extraInfo 透传

  @Prop({ index: true })
  dataId: string;                      // 表格记录 id（回填用）

  @Prop({ required: true, index: true })
  phone: string;                       // 手机号

  @Prop()
  name: string;

  @Prop()
  position: string;

  @Prop()
  interviewer: string;                 // 一面面试官姓名（约面按此查 HR 名录建日程）

  @Prop()
  interviewTime: string;

  @Prop()
  hrBotUserId: string;                 // 发起触达的 HR 托管账号

  @Prop({ type: String, enum: ReachStatus, default: ReachStatus.PENDING, index: true })
  status: ReachStatus;

  @Prop()
  wxid: string;                        // 好友通过后填充

  @Prop()
  externalUserId: string;              // 好友通过后填充

  @Prop()
  chatId: string;                      // 发消息寻址用

  @Prop({ default: false, index: true })
  humanTakeover: boolean;              // 转人工：true=AI 不接待此对话，HR 真人跟进（表格【转人工】字段同步来）

  @Prop()
  intent: string;                      // 候选人意图

  @Prop({ type: Object })
  intentSlots: Record<string, any>;    // 意图槽位

  @Prop()
  meetingLink: string;                 // 候选人确认约面后创建的飞书视频会议链接

  @Prop()
  scheduleEventId: string;             // 对应的飞书日历日程 event_id

  @Prop({ type: [{ at: Date, event: String, detail: String }], default: [] })
  timeline: TimelineEntry[];           // 全流程留痕
}

export const ReachTaskSchema = SchemaFactory.createForClass(ReachTask);
