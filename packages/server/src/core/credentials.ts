import { z } from "zod";
import { slugMaxLength, slugPattern } from "@imageshow/shared/browser";

export const adminUsernameInput = z.string().trim().toLowerCase()
  .min(1, "用户名不能为空")
  .max(slugMaxLength, `用户名最长 ${slugMaxLength} 个字符`)
  .regex(slugPattern, "用户名只能包含小写字母、数字、连字符，且不能以连字符开头或结尾");

export const adminPasswordInput = z.string().min(8).max(128)
  .regex(/^(?=.*[A-Za-z])(?=.*\d).+$/, "密码至少 8 位，且需同时包含字母和数字");
