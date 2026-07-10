import { emitKeypressEvents } from "node:readline";
import { pool, pingDb } from "./core/db.ts";
import { pingRedis, redis } from "./core/redis-client.ts";
import { parseAdminPasswordCommand } from "./users/admin-password-command.ts";
import { resetAdministratorPasswordWithSessionCleanup } from "./users/password-recovery.ts";
import {
  adminSessionRedisClient,
  invalidateAllAdminSessions
} from "./users/session-invalidation.ts";

type Keypress = {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
};

function readHiddenLine(prompt: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error("密码恢复命令需要交互式终端");
  }

  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onKeypress = (input: string, key: Keypress) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) {
        finish(new Error("密码输入已取消"));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish();
        return;
      }
      if (key.name === "backspace") {
        value = Array.from(value).slice(0, -1).join("");
        return;
      }
      if (!key.ctrl && input && !/[\r\n]/.test(input)) value += input;
    };
    process.stdin.on("keypress", onKeypress);
  });
}

async function main() {
  const { username } = parseAdminPasswordCommand(process.argv.slice(2));
  const password = await readHiddenLine("新密码: ");
  const confirmation = await readHiddenLine("确认新密码: ");
  if (password !== confirmation) throw new Error("两次输入的密码不一致");

  await pingDb();
  const result = await resetAdministratorPasswordWithSessionCleanup(
    (sql, params) => pool.query(sql, params),
    async () => {
      await pingRedis();
      return invalidateAllAdminSessions(adminSessionRedisClient(redis));
    },
    username,
    password
  );
  if (result.sessionsInvalidated) {
    process.stdout.write(`管理员 ${result.username} 的密码已重置，已清除 ${result.removedSessions} 个登录会话。\n`);
    return;
  }

  const reason = result.error instanceof Error ? result.error.message : String(result.error);
  process.stdout.write(`管理员 ${result.username} 的密码已重置。\n`);
  process.stderr.write(
    `警告：Redis 会话清理失败（${reason}）。旧会话可能在 Redis 恢复后继续有效，\n` +
    "请恢复 Redis 后清空 imageshow:session:*，或重新执行密码重置命令。\n"
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  redis.disconnect();
  await pool.end().catch(() => undefined);
}
