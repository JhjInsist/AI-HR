import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Redis } from 'ioredis';
import { ConfigService } from '../config/config.service';
import { FeishuService } from '../feishu/feishu.service';
import { MiaohuiService } from '../miaohui/miaohui.service';
import { HrService } from '../hr/hr.service';
import { ReachTask, ReachStatus, ReachTaskDocument } from './reach.schema';
import { REACH_REDIS } from './reach.module';

/** 发起触达入参（表格服务 → POST /reach） */
export interface CreateReachDto {
  dataId?: string;
  phone: string;
  interviewTime?: string;
  name?: string;
  position?: string;
  interviewer?: string; // 一面面试官姓名（建日程按此查 HR 名录，可不传→兜底查进度表）
}

function cellText(v: any): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? x.text ?? x.name ?? '' : String(x))).join('');
  if (typeof v === 'object') return v.text ?? v.name ?? '';
  return String(v);
}

/**
 * 解析约面时间为 Unix 毫秒时间戳（兼容多格式；解析不了返回 null）。
 * 支持：Unix 毫秒/秒时间戳、ISO datetime（含时区）、"YYYY-MM-DD HH:mm"（按本地时区）。
 * 注：表格服务实际传的格式待确认，此处做尽量宽松的兼容。
 */
export function parseInterviewTime(raw?: string): number | null {
  const s = (raw || '').trim();
  if (!s) return null;
  // 纯数字：Unix 秒（10 位）或毫秒（13 位）时间戳
  if (/^\d{10}$/.test(s)) return parseInt(s, 10) * 1000;
  if (/^\d{13}$/.test(s)) return parseInt(s, 10);
  // "YYYY-MM-DD HH:mm[:ss]"：按东八区解释墙上时间（服务器时区无关：当 UTC 算再减 8 小时）
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - 8 * 3600 * 1000;
    return isNaN(t) ? null : t;
  }
  // 其余交给 Date 兜底（ISO 带时区等）
  const t = new Date(s).getTime();
  return isNaN(t) ? null : t;
}

/** 约面时间友好展示（按东八区 YYYY-MM-DD HH:mm）；解析不了则原样返回 */
export function formatInterviewTimeText(raw?: string): string {
  const s = (raw || '').trim();
  if (!s) return '（时间待定）';
  const ms = parseInterviewTime(s);
  if (ms == null) return s;
  const d = new Date(ms + 8 * 3600 * 1000); // 手动偏移到 UTC+8，规避服务器时区
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * 统一的邀约话术（带姓名+岗位+约面时间+请确认）。
 * 招聘纯企微场景 wecom-contact-bind 画布触发不可用，故把邀约直接并进加好友申请语，
 * 好友一通过候选人即看到带时间的完整邀约；候选人回复走画布 receive 意图链。
 */
export function buildInviteMessage(name?: string, position?: string, interviewTimeRaw?: string): string {
  const timeText = formatInterviewTimeText(interviewTimeRaw);
  const pos = position || '相关';
  const who = name ? `${name}您好` : '您好';
  return `${who}~ 我是句子互动招聘助理😊 您应聘的【${pos}】岗位，一面初步约在 ${timeText}。方便的话回复「可以」确认；如需调整，回复您方便的时间就好~`;
}

/** 意图字符串 → 状态机取值（兼容中英文/画布回报） */
const INTENT_STATUS: Record<string, ReachStatus> = {
  ACCEPT: ReachStatus.INTENT_ACCEPT, TIME: ReachStatus.INTENT_ACCEPT, 确认: ReachStatus.INTENT_ACCEPT,
  RESCHEDULE: ReachStatus.INTENT_RESCHEDULE, 改约: ReachStatus.INTENT_RESCHEDULE, 改期: ReachStatus.INTENT_RESCHEDULE,
  REJECT: ReachStatus.INTENT_REJECT, 拒绝: ReachStatus.INTENT_REJECT,
  QUESTION: ReachStatus.INTENT_QUESTION, 提问: ReachStatus.INTENT_QUESTION,
  HANDOVER: ReachStatus.HANDOVER, 转人工: ReachStatus.HANDOVER,
};

/**
 * 触达编排状态机（方案第五节）。
 * 建任务 → 秒回加好友 → 好友通过回调 → 画布欢迎语/意图回报 → 同步HR + 回填进度表。
 * 所有外部回调走「200 + 异步 + 幂等」；幂等靠 Redis SET NX。
 */
@Injectable()
export class ReachService {
  private readonly logger = new Logger(ReachService.name);
  private get dry() { return this.config.getBool('DRY_RUN', true); }
  private get PROG_APP() { return this.config.get('PROG_APP_TOKEN'); }
  private get PROG_TBL() { return this.config.get('PROG_TABLE_ID'); }

  constructor(
    @InjectModel(ReachTask.name) private readonly taskModel: Model<ReachTaskDocument>,
    @Inject(REACH_REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly feishu: FeishuService,
    private readonly miaohui: MiaohuiService,
    private readonly hr: HrService,
  ) {}

  // ── 幂等锁：SET key NX EX；Redis 不可用时不阻断业务（返回可继续） ──
  private async lock(key: string, ttlSec = 300): Promise<boolean> {
    try {
      const r = await this.redis.set(key, '1', 'EX', ttlSec, 'NX');
      return r === 'OK';
    } catch (e: any) {
      this.logger.warn(`Redis 锁异常，放行 ${key}: ${e?.message}`);
      return true;
    }
  }

  private async appendTimeline(taskId: string, event: string, detail?: string) {
    await this.taskModel.updateOne(
      { taskId },
      { $push: { timeline: { at: new Date(), event, detail } } },
    ).exec();
  }

  // ───────────────────────── ① 发起触达 ─────────────────────────
  /** 建任务(ADDING) → 秒回加好友(extraInfo=taskId, userId=hrBotUserId) → 记 timeline */
  async createTask(dto: CreateReachDto) {
    const phone = (dto.phone || '').trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) return { ok: false, msg: '缺少或非法手机号 phone' };

    // 幂等：同号短时间内只建一次任务
    if (!(await this.lock(`reach:create:${phone}`, 60))) {
      return { ok: false, msg: '该手机号触达刚发起过，请勿重复', duplicate: true };
    }

    const taskId = `RT${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const hrBotUserId = this.config.get('MIAOHUI_BOT_USERID', 'jiahongjia');
    const doc = await this.taskModel.create({
      taskId,
      dataId: dto.dataId || '',
      phone,
      name: dto.name || '',
      position: dto.position || '',
      interviewer: dto.interviewer || '',
      interviewTime: dto.interviewTime || '',
      hrBotUserId,
      status: ReachStatus.ADDING,
      timeline: [{ at: new Date(), event: 'CREATE', detail: `建任务，约面时间=${dto.interviewTime || '未填'}` }],
    });

    // 邀约并进加好友申请语：有约面时间则用带时间的完整邀约，好友一通过即看到（不依赖画布触发）
    const hasTime = parseInterviewTime(dto.interviewTime) != null;
    const hello = hasTime
      ? buildInviteMessage(dto.name, dto.position, dto.interviewTime)
      : this.config.get('HELLO_MSG', '你好，我是句子互动招聘助理，看到你投递的岗位，想跟你约一次面试~');
    const res = await this.miaohui.addFriendByPhone(phone, hello, { extraInfo: taskId, userId: hrBotUserId });
    if (!res.ok) {
      doc.status = ReachStatus.ADD_FAILED;
      await doc.save();
      await this.appendTimeline(taskId, 'ADD_FAILED', `发起加好友失败 code=${res.code}`);
      await this.notifyHr(`❌【触达失败】${dto.name || phone} 加好友请求发送失败（code=${res.code}），请HR人工处理。`);
      await this.backfillProgress(doc, `触达失败：加好友请求发送失败(code=${res.code})`);
      return { ok: false, taskId, msg: '加好友发起失败', code: res.code };
    }
    await this.appendTimeline(taskId, 'ADD_SENT', `已发起加好友 code=${res.code}`);
    return { ok: true, taskId, status: ReachStatus.ADDING };
  }

  // ───────────────────────── ② 秒回回调分发 ─────────────────────────
  /** 统一回调入口。按 body 字段分发：friend/confirm、friend/send、sentResult。 */
  async handleCallback(body: any) {
    // ⚠️ 秒回小组级回调字段都在 data 下：body = { code, data: {...} }（见 known-everything 回调文档）
    const d = body?.data || body;
    // 回调来源校验：回调 body.data.token 是小组级 token，须与配置的 MIAOHUI_GROUP_TOKEN 一致
    const groupToken = this.config.get('MIAOHUI_GROUP_TOKEN');
    if (groupToken && d?.token && d.token !== groupToken) {
      this.logger.warn('[mh回调] token 不匹配，忽略该回调');
      return;
    }
    const id = d?.messageId || d?.requestId || body?.eventId;
    try {
      // 接收消息回调（候选人回复，data.isSelf + data.contactId）→ 由秒懂画布处理，触达服务忽略
      if (d?.isSelf !== undefined && d?.contactId) return;
      // 发送消息结果回调：带 sentStatus
      if (d?.sentStatus !== undefined) return await this.onSentResult(d, id);
      // 加好友任务结果回调：带 createTimestamp（区别于好友通过，两者都有 code+phoneNum+extraInfo）
      if (d?.createTimestamp !== undefined && d?.code !== undefined) return await this.onFriendSend(d, id);
      // 好友通过回调：带 wxid + phoneNum + externalUserId
      if (d?.wxid && d?.phoneNum) return await this.onFriendConfirm(d, id);
      this.logger.log(`[mh回调] 未识别类型 keys=${Object.keys(d || {}).join(',')}`);
    } catch (e: any) {
      this.logger.error(`[mh回调] 处理异常: ${e?.message}`);
    }
  }

  /** 好友通过：status=CONFIRMED，存 wxid/externalUserId */
  private async onFriendConfirm(body: any, id?: string) {
    const key = `mh:confirm:${id || body.wxid || body.phoneNum}`;
    if (!(await this.lock(key))) return;
    const task = await this.findTask(body);
    if (!task) { this.logger.warn(`[friend/confirm] 未找到任务 phone=${body.phoneNum} extraInfo=${body.extraInfo}`); return; }
    task.status = ReachStatus.CONFIRMED;
    task.wxid = body.wxid || task.wxid;
    task.externalUserId = body.externalUserId || body.externalUserid || task.externalUserId;
    await task.save();
    await this.appendTimeline(task.taskId, 'CONFIRMED', `好友通过 wxid=${task.wxid}`);
    this.logger.log(`[friend/confirm] ${task.name || task.phone} 好友已通过`);
  }

  /** 加好友结果：code=1 失败 → ADD_FAILED + 通知HR */
  private async onFriendSend(body: any, id?: string) {
    const key = `mh:friendsend:${id || body.extraInfo || body.phoneNum}`;
    if (!(await this.lock(key))) return;
    const task = await this.findTask(body);
    if (!task) { this.logger.warn(`[friend/send] 未找到任务 phone=${body.phoneNum} extraInfo=${body.extraInfo}`); return; }
    if (body.code === 1) {
      task.status = ReachStatus.ADD_FAILED;
      await task.save();
      await this.appendTimeline(task.taskId, 'ADD_FAILED', `加好友失败 errorCode=${body.errorCode ?? body.code}`);
      await this.notifyHr(`❌【触达失败】${task.name || task.phone} 加好友未成功（errorCode=${body.errorCode ?? body.code}），请HR人工处理。`);
      await this.backfillProgress(task, `触达失败：加好友未成功(errorCode=${body.errorCode ?? body.code})`);
    } else {
      await this.appendTimeline(task.taskId, 'ADD_OK', `加好友请求已受理 code=${body.code}`);
    }
  }

  /** 发送结果：sentStatus=false 失败 → 通知HR */
  private async onSentResult(body: any, id?: string) {
    const key = `mh:sent:${id || body.externalRequestId || body.phoneNum}`;
    if (!(await this.lock(key))) return;
    const task = await this.findTask(body);
    const who = task ? (task.name || task.phone) : (body.phoneNum || '某候选人');
    if (body.sentStatus === false) {
      if (task) await this.appendTimeline(task.taskId, 'SEND_FAILED', `发消息失败 ${body.reason || ''}`);
      await this.notifyHr(`⚠️【发送失败】给 ${who} 发送消息失败，请HR关注。`);
    } else if (task) {
      await this.appendTimeline(task.taskId, 'SEND_OK', '消息已送达');
    }
  }

  // ───────────────────────── ③ 画布 plugin：查约面信息 ─────────────────────────
  /**
   * 好友通过后画布发欢迎语用。返回结构化字段 + 拼好的 welcome 文本（画布直接发，话术确定性）。
   * externalId：画布传来的 wecomContactId/externalUserId，存入任务作关联键，供后续意图回报匹配。
   */
  async getCandidateInfo(phone: string, externalId?: string): Promise<{ found: boolean; name?: string; position?: string; interviewTime?: string; welcome?: string }> {
    const task = await this.taskModel.findOne({ phone: (phone || '').trim() }).sort({ createdAt: -1 }).exec();
    if (!task) return { found: false };
    let dirty = false;
    // 关联键：画布带来的 contactId 存下，后面 report-intent 按它匹配任务（秒回回调缺失时的兜底）
    const ext = (externalId || '').trim();
    if (ext && task.externalUserId !== ext) { task.externalUserId = ext; dirty = true; }
    // 命中即认为欢迎语链已触发，推进到 WELCOMED（幂等：仅从 CONFIRMED/ADDING 推进）
    if (task.status === ReachStatus.CONFIRMED || task.status === ReachStatus.ADDING) {
      task.status = ReachStatus.WELCOMED;
      dirty = true;
      await this.appendTimeline(task.taskId, 'WELCOMED', `画布取约面信息发欢迎语${ext ? ` contactId=${ext}` : ''}`);
    }
    if (dirty) await task.save();
    const welcome = buildInviteMessage(task.name, task.position, task.interviewTime);
    return { found: true, name: task.name, position: task.position, interviewTime: task.interviewTime, welcome };
  }

  // ───────────────────────── ④ 画布 plugin：意图回报 ─────────────────────────
  /** 画布识别意图后回报：更新 status=INTENT_xxx + 回填进度表 + 通知HR。 */
  async reportIntent(externalId: string, intent: string, slots?: Record<string, any>) {
    const id = (externalId || '').trim();
    // 画布(receive-text-message)回报的是 contactId；触达任务好友通过时存了 externalUserId/wxid。
    // 灵活匹配这三个字段（联调用真实回调样例确认 contactId 具体等于 externalUserId 还是 wxid）。
    const task = await this.taskModel.findOne({ $or: [{ externalUserId: id }, { wxid: id }, { phone: id }] }).sort({ createdAt: -1 }).exec();
    if (!task) return { ok: false, msg: `未找到 ${id} 的触达任务` };

    const status = INTENT_STATUS[(intent || '').toUpperCase()] || INTENT_STATUS[intent] || ReachStatus.REPLIED;
    task.intent = intent;
    if (slots) task.intentSlots = slots;
    // 提问不改主状态（答疑不打扰HR）
    if (status !== ReachStatus.INTENT_QUESTION) task.status = status;
    else if (task.status === ReachStatus.WELCOMED) task.status = ReachStatus.REPLIED;
    await task.save();
    await this.appendTimeline(task.taskId, `INTENT_${intent}`, slots ? JSON.stringify(slots) : undefined);

    // 确认约面：在 HR 飞书日历建带视频会议的面试日程，拿会议链接（失败不阻断）
    let meetingLink = task.meetingLink || '';
    if (status === ReachStatus.INTENT_ACCEPT && !meetingLink) {
      meetingLink = await this.scheduleInterview(task, slots);
    }

    // 同步HR：确认/改约/拒绝/转人工才通知；提问不打扰
    const slotTime = slots?.time || slots?.interviewTime || '';
    const notifyMap: Record<string, string> = {
      [ReachStatus.INTENT_ACCEPT]: `✅【候选人已确认】${task.name || id} 确认约面${slotTime ? `：${slotTime}` : ''}。${meetingLink ? `\n面试会议链接：${meetingLink}` : ''}`,
      [ReachStatus.INTENT_RESCHEDULE]: `🔄【候选人要改约】${task.name || id} 希望调整面试时间${slotTime ? `：${slotTime}` : ''}，请HR协调。`,
      [ReachStatus.INTENT_REJECT]: `🚫【候选人拒绝】${task.name || id} 婉拒本次面试，流程关闭。`,
      [ReachStatus.HANDOVER]: `👤【转人工】${task.name || id} 需真人跟进，请HR接手。`,
    };
    const msg = notifyMap[status];
    if (msg) await this.notifyHr(msg);
    await this.backfillProgress(task, `候选人意图=${intent}${slotTime ? `(${slotTime})` : ''}`);
    return { ok: true, taskId: task.taskId, status: task.status, meetingLink };
  }

  /**
   * 候选人确认约面后，在 HR 飞书日历创建带视频会议的面试日程。
   * 取值优先级：slots.time/interviewTime > task.interviewTime。解析不了则跳过建日程（记 warning）。
   * 建日程失败/无 HR_EMAIL 均不阻断，返回空链接。成功则把 meetingLink/eventId 存入 task。
   */
  private async scheduleInterview(task: ReachTaskDocument, slots?: Record<string, any>): Promise<string> {
    const raw = (slots?.time || slots?.interviewTime || task.interviewTime || '').toString();
    const start = parseInterviewTime(raw);
    if (start == null) {
      this.logger.warn(`[约面日程] 无法解析约面时间「${raw}」，跳过建日程 task=${task.taskId}`);
      await this.appendTimeline(task.taskId, 'SCHEDULE_SKIP', `约面时间无法解析：${raw}`);
      return '';
    }
    // 选面试官 HR：按面试官姓名查名录拿邮箱/openId，回退全局 HR_EMAIL
    const { email: hrEmail, openId: hrOpenId, interviewer } = await this.resolveHr(task);
    if (!hrEmail && !hrOpenId) {
      this.logger.warn(`[约面日程] 未匹配到 HR（面试官=${interviewer || '未知'}）且无 HR_EMAIL，跳过建日程 task=${task.taskId}`);
      await this.appendTimeline(task.taskId, 'SCHEDULE_SKIP', `未匹配到 HR（面试官=${interviewer || '未知'}）`);
      return '';
    }
    const end = start + 60 * 60 * 1000; // 结束=开始+1小时
    try {
      const { eventId, meetingUrl } = await this.feishu.createInterviewEvent({
        hrEmail,
        hrOpenId,
        summary: `面试-${task.name || task.phone}-${task.position || '岗位待定'}`,
        startTime: start,
        endTime: end,
        description: `候选人：${task.name || ''}（${task.phone}）\n岗位：${task.position || ''}\n面试官：${interviewer || '（未指定）'}`,
      });
      task.meetingLink = meetingUrl || '';
      task.scheduleEventId = eventId || '';
      await task.save();
      await this.appendTimeline(task.taskId, 'SCHEDULE_OK', `建面试日程 event=${eventId} 会议链接=${meetingUrl || '(空)'}`);
      return meetingUrl || '';
    } catch (e: any) {
      this.logger.error(`[约面日程] 建日程失败 task=${task.taskId}: ${e?.message}`);
      await this.appendTimeline(task.taskId, 'SCHEDULE_FAILED', e?.message);
      return '';
    }
  }

  /**
   * 解析该任务应约给哪个 HR。
   * 面试官姓名：task.interviewer 优先，空则查进度表「一面面试官」。
   * 有面试官 → 查 HR 名录拿 {email, openId}；名录无此人则回退全局 HR_EMAIL。
   */
  private async resolveHr(task: ReachTaskDocument): Promise<{ email: string; openId: string; interviewer: string }> {
    let interviewer = (task.interviewer || '').trim();
    if (!interviewer) interviewer = await this.lookupInterviewer(task);
    if (interviewer) {
      const m = await this.hr.findByName(interviewer);
      if (m && (m.email || m.openId)) return { email: m.email || '', openId: m.openId || '', interviewer };
      this.logger.warn(`[约面日程] HR 名录无面试官「${interviewer}」，回退全局 HR_EMAIL`);
    }
    return { email: this.config.get('HR_EMAIL'), openId: '', interviewer };
  }

  /** 从进度表按 dataId/phone 找记录，读「一面面试官」姓名（task.interviewer 未传时兜底） */
  private async lookupInterviewer(task: ReachTaskDocument): Promise<string> {
    if (!this.PROG_APP || !this.PROG_TBL) return '';
    try {
      const rows = await this.feishu.listRecords(this.PROG_APP, this.PROG_TBL);
      const rec = rows.find((r) => {
        if (task.dataId && r.record_id === task.dataId) return true;
        const c = cellText(r.fields['联系方式']) || cellText(r.fields['电话']) || cellText(r.fields['手机号']);
        return c.includes(task.phone);
      });
      return rec ? cellText(rec.fields['一面面试官']) : '';
    } catch (e: any) {
      this.logger.warn(`[约面日程] 查进度表面试官失败: ${e?.message}`);
      return '';
    }
  }

  // ───────────────────────── 公共：定位/通知/回填 ─────────────────────────
  /** 按 extraInfo(taskId) 优先，回退 phone 定位任务 */
  private async findTask(body: any): Promise<ReachTaskDocument | null> {
    if (body?.extraInfo) {
      const t = await this.taskModel.findOne({ taskId: body.extraInfo }).exec();
      if (t) return t;
    }
    if (body?.phoneNum) {
      return this.taskModel.findOne({ phone: body.phoneNum }).sort({ createdAt: -1 }).exec();
    }
    return null;
  }

  /** 飞书通知HR（HR_NOTIFY_CHAT） */
  private async notifyHr(text: string) {
    const chat = this.config.get('HR_NOTIFY_CHAT');
    if (!chat) { this.logger.warn(`未配置 HR_NOTIFY_CHAT，跳过通知：${text}`); return; }
    try { await this.feishu.sendText(chat, text); }
    catch (e: any) { this.logger.error(`通知HR失败: ${e?.message}`); }
  }

  /** 回填进度表：按 dataId 优先、回退 phone 定位记录，追加备忘录 */
  private async backfillProgress(task: ReachTaskDocument, note: string) {
    if (this.dry) { this.logger.log(`[DRY] 回填进度表 ${task.phone} += ${note}`); return; }
    if (!this.PROG_APP || !this.PROG_TBL) return;
    try {
      const rows = await this.feishu.listRecords(this.PROG_APP, this.PROG_TBL);
      const rec = rows.find((r) => {
        if (task.dataId && r.record_id === task.dataId) return true;
        const contact = cellText(r.fields['联系方式']) || cellText(r.fields['电话']) || cellText(r.fields['手机号']);
        return contact.includes(task.phone);
      });
      if (!rec) { this.logger.warn(`进度表未找到记录 dataId=${task.dataId} phone=${task.phone}，跳过回填`); return; }
      const prev = cellText(rec.fields['备忘录']);
      const stamp = new Date().toISOString().slice(5, 16).replace('T', ' ');
      await this.feishu.updateRecord(this.PROG_APP, this.PROG_TBL, rec.record_id, {
        '备忘录': `${prev} | [触达 ${stamp}] ${note}`.slice(0, 900),
      });
      this.logger.log(`进度表已回填 ${task.phone}：${note}`);
    } catch (e: any) {
      this.logger.error(`回填进度表失败 ${task.phone}: ${e?.message}`);
    }
  }
}
