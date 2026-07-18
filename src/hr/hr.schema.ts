import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type HrMappingDocument = HydratedDocument<HrMapping>;

/**
 * 面试官 HR 名录（MongoDB `hr_mappings`）。
 * 姓名须与进度表「一面面试官」写法一致，约面确认后按姓名查此表拿邮箱建面试日程。
 */
@Schema({ collection: 'hr_mappings', timestamps: true })
export class HrMapping {
  @Prop({ required: true, unique: true, index: true })
  name: string; // 面试官姓名（对应进度表「一面面试官」）

  @Prop({ default: '' })
  email: string; // 飞书邮箱：建日程 / 邀请参会（代码用它换 open_id）

  @Prop({ default: '' })
  openId: string; // 可选：直接填 open_id 则不再用邮箱换

  @Prop({ default: '' })
  note: string; // 备注（岗位/团队等，仅展示）
}

export const HrMappingSchema = SchemaFactory.createForClass(HrMapping);
