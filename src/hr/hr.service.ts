import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { HrMapping, HrMappingDocument } from './hr.schema';

/** 面试官 HR 名录：姓名 ↔ 飞书邮箱/open_id 的增删查，供约面建日程按面试官选人。 */
@Injectable()
export class HrService {
  private readonly logger = new Logger(HrService.name);

  constructor(
    @InjectModel(HrMapping.name) private readonly model: Model<HrMappingDocument>,
  ) {}

  /** 全部名录（按姓名排序，供配置台回显） */
  list(): Promise<HrMappingDocument[]> {
    return this.model.find().sort({ name: 1 }).exec();
  }

  /** 新增/更新（按姓名 upsert），返回最新全量 */
  async upsert(input: { name?: string; email?: string; openId?: string; note?: string }): Promise<HrMappingDocument[]> {
    const name = (input.name || '').trim();
    if (!name) throw new Error('缺少面试官姓名');
    await this.model.updateOne(
      { name },
      { $set: { email: (input.email || '').trim(), openId: (input.openId || '').trim(), note: (input.note || '').trim() } },
      { upsert: true },
    ).exec();
    this.logger.log(`HR 名录已保存: ${name}`);
    return this.list();
  }

  /** 删除，返回最新全量 */
  async remove(name: string): Promise<HrMappingDocument[]> {
    await this.model.deleteOne({ name: (name || '').trim() }).exec();
    this.logger.log(`HR 名录已删除: ${name}`);
    return this.list();
  }

  /** 按姓名查（约面建日程用），未命中返回 null */
  findByName(name: string): Promise<HrMappingDocument | null> {
    return this.model.findOne({ name: (name || '').trim() }).exec();
  }
}
