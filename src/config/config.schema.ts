import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AppConfigDocument = HydratedDocument<AppConfigItem>;

/** 运行时配置项（MongoDB `app_config`，一 key 一条，替代原 data/config.json） */
@Schema({ collection: 'app_config', timestamps: true })
export class AppConfigItem {
  @Prop({ required: true, unique: true, index: true })
  key: string;

  @Prop({ default: '' })
  value: string;
}

export const AppConfigSchema = SchemaFactory.createForClass(AppConfigItem);
