/**
 * 数据路由（需求 §6.2）：读取与条目级合并写入。
 */
import { mergeData, readRevision, readServerData, writeMergedData } from '../data.ts';
import { parseClientData } from '../serialize.ts';
import type { RouteContext, RouteResponse } from '../http.ts';

export function handleGetData(ctx: RouteContext): RouteResponse {
  const server = readServerData(ctx.db);
  return {
    status: 200,
    body: {
      revision: readRevision(ctx.db),
      reminders: server.reminders,
      tags: server.tags,
      settings: server.settings,
      tombstones: server.tombstones,
    },
  };
}

export function handlePutData(ctx: RouteContext): RouteResponse {
  const serverRevisionBefore = readRevision(ctx.db);
  const client = parseClientData(ctx.body);
  const server = readServerData(ctx.db);
  const outcome = mergeData(server, {
    reminders: client.reminders,
    tags: client.tags,
    settings: client.settings,
    tombstones: client.tombstones,
  });
  const revision = writeMergedData(ctx.db, outcome);
  // 本机数据变更 → 触发 WebDAV 延迟上传（节流，未启用时不生效）。
  if (outcome.changed) ctx.sync?.markLocalChange();
  const actor = ctx.identity?.username ?? 'unknown';
  ctx.db
    .prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)')
    .run(
      ctx.now,
      actor,
      'put_data',
      JSON.stringify({
        baseRevision: client.baseRevision,
        serverRevisionBefore,
        revision,
        rejected: client.rejected,
      }),
    );
  return {
    status: 200,
    body: {
      revision,
      serverRevisionBefore,
      baseRevision: client.baseRevision,
      rejected: client.rejected,
      reminders: outcome.reminders,
      tags: outcome.tags,
      settings: outcome.settings,
      tombstones: outcome.tombstones,
    },
  };
}
