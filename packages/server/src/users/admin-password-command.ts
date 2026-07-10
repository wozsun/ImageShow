import { adminUsernameInput } from "./credentials.ts";

const adminPasswordCommandUsage = "用法: imageshow reset-password <username>";

export function parseAdminPasswordCommand(arguments_: string[]) {
  if (arguments_.length !== 2 || arguments_[0] !== "reset-password") {
    throw new Error(adminPasswordCommandUsage);
  }
  return { username: adminUsernameInput.parse(arguments_[1]) };
}
