'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {useT, type TFn} from '@/lib/i18n/provider';
import {useRealm} from '@/lib/realm-context';
import {
  Loader2, CheckCircle2, XCircle, Play, ExternalLink, AlertTriangle,
  RotateCw, SkipForward, Copy,
} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {accountApi, errText} from '@/lib/api';
import {copyText} from '@/lib/format';
import {notify} from '@/lib/toast';
import {cn} from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
} from '@/components/animate-ui/radix/dialog';

type Row = {
  i: number;                                   // 1-based 序号
  name: string;                                // 备注（粘贴模式下就是邮箱）
  secret?: string;                             // 粘贴清单里的密码，只在内存里周转
  fid: string;                                 // OAuth 会话 id（轮到时才建）
  url: string;                                 // 授权 url（iframe src）
  status: 'queued' | 'starting' | 'active' | 'ok' | 'failed';
  detail?: string;                             // nickname/uid 或错误
  startedMs?: number;
};

const POLL_MS = 2500;
// 服务端会话 TTL 是 300s，这里留点富余，免得刚好卡在过期那一秒被判成失败
const POLL_TIMEOUT_S = 270;
const MAX_N = 12;

/**
 * 拆粘贴进来的账号清单：一行一个，`邮箱|密码` 或纯邮箱。
 *
 * 密码只用来给用户一键复制到登录弹窗里，不参与任何请求——所以它只活在这个
 * 组件的内存里，既不落 localStorage 也不发给后端。重复的邮箱只留第一条，
 * 否则同一个人会被排队登录两次。
 */
function parseRoster(raw: string): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const line of raw.split('\n')) {
    // 中文输入法里 `|` 很容易打成全角，不归一化的话整行会被当成一个邮箱
    const cells = line.replace(/｜/g, '|').split('|');
    const name = (cells[0] ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      i: out.length + 1,
      name,
      secret: (cells[1] ?? '').trim(),
      fid: '',
      url: '',
      status: 'queued',
    });
    if (out.length >= MAX_N) break;
  }
  return out;
}

export function BatchOAuthDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess?: () => void;
}) {
  const t = useT();
  const {realm, label: realmName} = useRealm();

  const [count, setCount] = useState(4);
  const [prefix, setPrefix] = useState('batch');
  const [raw, setRaw] = useState('');              // 粘贴进来的账号清单原文
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [rows, setRows] = useState<Row[]>([]);
  const [reloadKey, setReloadKey] = useState(0);   // 重载 iframe 用

  const roster = parseRoster(raw);

  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = rows;
  const pollerRef = useRef(0);                     // 当前唯一在跑的轮询句柄
  const busyRef = useRef(false);                   // 串行闸门：一次只跑一个会话
  const runRef = useRef<(i: number) => void>(() => {});

  const stopPolling = useCallback(() => {
    if (pollerRef.current) window.clearInterval(pollerRef.current);
    pollerRef.current = 0;
  }, []);

  useEffect(() => {
    if (!open) {
      stopPolling();
      busyRef.current = false;
      setPhase('idle');
      setRows([]);
    }
  }, [open, stopPolling]);

  /** 给第 i 行定案：停轮询、写结果、释放闸门、推进队列里的下一个。 */
  const settle = useCallback((i: number, status: 'ok' | 'failed', detail: string) => {
    stopPolling();
    setRows((prev) => prev.map((r) => (r.i === i ? {...r, status, detail} : r)));
    busyRef.current = false;
    // rowsRef 此刻还是本轮渲染前的值，但第 i 行不是 queued，找下一个不受影响
    const next = rowsRef.current.find((r) => r.i !== i && r.status === 'queued');
    if (next) runRef.current(next.i);
  }, [stopPolling]);

  /**
   * 跑第 i 个：轮到时才建会话 → 挂 iframe → 轮询到结果。
   *
   * 一次只放一个 iframe：授权页是完整的 SPA，N 个同时挂载会让浏览器把 CPU 和
   * 内存吃满，表现为整页卡死。串行还有个附带好处 —— 会话按需创建，不会出现
   * 排队排到一半、服务端 TTL(300s) 已经过期的情况。
   */
  const runOne = useCallback(async (i: number) => {
    if (busyRef.current) return;
    busyRef.current = true;
    stopPolling();
    setRows((prev) => prev.map((r) => (r.i === i ? {...r, status: 'starting'} : r)));

    const name = `${prefix}-${String(i).padStart(2, '0')}`;
    const version = realm === 'global' ? 'intl' : 'cn';

    let flow: {id: string; url: string};
    try {
      flow = await accountApi.oauthStart(name, version, true);
    } catch (e) {
      settle(i, 'failed', errText(e));
      return;
    }

    const startedMs = Date.now();
    setRows((prev) =>
      prev.map((r) => (r.i === i ? {...r, ...flow, status: 'active', startedMs} : r)),
    );

    pollerRef.current = window.setInterval(async () => {
      let s: Awaited<ReturnType<typeof accountApi.oauthPoll>>;
      try {
        s = await accountApi.oauthPoll(flow.id);
      } catch {
        return;                                  // 网络抖动，下一轮再试
      }
      if (s.status === 'success') {
        const sec = Math.round((Date.now() - startedMs) / 1000);
        const detail = [s.nickname && `@${s.nickname}`, s.uid, `${sec}s`]
          .filter(Boolean).join('  ·  ');
        settle(i, 'ok', detail);
      } else if (s.status === 'expired' || s.status === 'invalid') {
        settle(i, 'failed', s.status);
      } else if ((Date.now() - startedMs) / 1000 > POLL_TIMEOUT_S) {
        settle(i, 'failed', `timeout ${POLL_TIMEOUT_S}s`);
      }
    }, POLL_MS);
  }, [prefix, realm, settle, stopPolling]);

  runRef.current = (i: number) => void runOne(i);

  const start = () => {
    stopPolling();
    busyRef.current = false;

    // 粘贴了清单就按清单排队（备注直接用邮箱，登录完能一一对上号）；
    // 没粘就退回「数量 + 前缀」那套
    const n = Math.max(1, Math.min(MAX_N, count));
    const fresh: Row[] = roster.length
      ? roster
      : Array.from({length: n}, (_, k) => ({
          i: k + 1,
          name: `${prefix}-${String(k + 1).padStart(2, '0')}`,
          fid: '',
          url: '',
          status: 'queued' as const,
        }));

    // settle 会立刻回读 rowsRef 找下一个，不能等重渲染
    rowsRef.current = fresh;
    setRows(fresh);
    setPhase('running');
    runRef.current(1);
  };

  /** 跳过当前：取消服务端会话后直接推进。会话 TTL 有 5 分钟，不能干等。 */
  const skip = (row: Row) => {
    if (row.fid) void accountApi.oauthCancel(row.fid).catch(() => {});
    settle(row.i, 'failed', t('oauth.batchSkipped'));
  };

  /** 重试：清掉旧会话重排回队列，空闲就直接开跑。 */
  const retry = (i: number) => {
    setRows((prev) => prev.map((r) =>
      r.i === i ? {...r, status: 'queued', detail: undefined, fid: '', url: ''} : r));
    setPhase('running');            // 收尾后又有活了，别停在 done 态
    if (!busyRef.current) runRef.current(i);
  };

  // 全部结束（成功或失败）后收尾
  useEffect(() => {
    if (phase !== 'running') return;
    const pending = rows.filter(
      (r) => r.status === 'queued' || r.status === 'starting' || r.status === 'active',
    );
    if (rows.length > 0 && pending.length === 0) {
      setPhase('done');
      if (rows.some((r) => r.status === 'ok')) {
        onSuccess?.();
        window.dispatchEvent(new Event('workbuddy-manager:accounts-changed'));
      }
    }
  }, [rows, phase, onSuccess]);

  const ok = rows.filter((r) => r.status === 'ok').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const done = ok + failed;
  // 跑起来之后以实际排队的行数为准：粘贴清单时行数和「数量」输入框无关
  const total = rows.length || count;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const usingRoster = roster.length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          stopPolling();
          busyRef.current = false;
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-[760px] w-[92vw]" showCloseButton>
        <DialogHeader>
          <DialogTitle>{t('oauth.batchTitle', {realm: realmName})}</DialogTitle>
          {/* 两个版本的登录方式完全不同：国内版没有 Google 入口（微信扫码 /
              手机号 / 邮箱验证码 / SSO），照国际版写会让国内用户找一个不存在的按钮 */}
          <DialogDescription>
            {t(realm === 'global' ? 'oauth.batchDescGlobal' : 'oauth.batchDescCn')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex w-full flex-col gap-4 px-6 pb-6">
          {/* 粘贴清单：有内容就按它排队，下面的「数量 / 前缀」自动让位 */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-medium">{t('oauth.batchRosterTitle')}</div>
              {usingRoster && (
                <span className="font-mono text-[10px] text-emerald-600 dark:text-emerald-400">
                  {t('oauth.batchRosterParsed', {n: roster.length})}
                </span>
              )}
            </div>
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={3}
              disabled={phase === 'running'}
              placeholder={t('oauth.batchRosterPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              className="w-full resize-y rounded-lg border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
            />
            <div className="text-[10px] text-muted-foreground">{t('oauth.batchRosterHint')}</div>
          </div>

          {/* 控制栏 */}
          <div className="flex items-end gap-3">
            <div className="w-[110px] space-y-1">
              <div className="text-[11px] font-medium">{t('oauth.batchCount')}</div>
              <Input
                type="number" min={1} max={MAX_N} value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="h-9 rounded-full text-xs"
                disabled={phase === 'running' || usingRoster}
              />
            </div>
            <div className="w-[160px] space-y-1">
              <div className="text-[11px] font-medium">{t('oauth.batchPrefix')}</div>
              <Input
                value={prefix} onChange={(e) => setPrefix(e.target.value)}
                className="h-9 rounded-full text-xs"
                disabled={phase === 'running' || usingRoster}
              />
            </div>

            <div className="flex-1" />

            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px]">
                <span className="text-emerald-500">{ok}</span>
                <span className="text-muted-foreground">/{total}</span>
                {failed > 0 && <span className="text-amber-500"> · {failed} fail</span>}
              </span>
              {(phase === 'idle' || phase === 'done') && (
                <Button className="rounded-full gap-1.5" onClick={start}>
                  {phase === 'done'
                    ? <><RotateCw className="h-3.5 w-3.5" />{t('oauth.batchRestart')}</>
                    : <><Play className="h-3.5 w-3.5" />{t('oauth.batchStart')}</>}
                </Button>
              )}
              {phase === 'running' && (
                <Button className="rounded-full gap-1.5" disabled>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('oauth.batchRunning', {n: done, count: total})}
                </Button>
              )}
            </div>
          </div>

          {/* 进度条 */}
          {rows.length > 0 && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full transition-all',
                  failed > 0
                    ? 'bg-gradient-to-r from-amber-400 to-rose-500'
                    : 'bg-gradient-to-r from-blue-400 to-emerald-500',
                )}
                style={{width: `${pct}%`}}
              />
            </div>
          )}

          {/* 当前窗口 + 队列 */}
          <div className="flex flex-col gap-3">
            <ActiveSlot
              row={rows.find((r) => r.status === 'active' || r.status === 'starting')}
              t={t}
              reloadKey={reloadKey}
              onReload={() => setReloadKey((k) => k + 1)}
              onSkip={skip}
            />

            {rows.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {rows.map((r) => (
                  <QueueChip key={r.i} row={r} t={t} onRetry={() => retry(r.i)} />
                ))}
              </div>
            )}

            {rows.length > 0 && (
              <div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
                <span>{t('oauth.batchEmbedHint')}</span>
              </div>
            )}

            {phase === 'idle' && (
              <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                {t('oauth.batchIdleHint')}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 唯一的活动窗口：只有这里会挂 iframe，其余账号在队列里等。 */
function ActiveSlot({
  row, t, reloadKey, onReload, onSkip,
}: {
  row?: Row;
  t: TFn;
  reloadKey: number;
  onReload: () => void;
  onSkip: (row: Row) => void;
}) {
  if (!row) {
    return (
      <div className="flex h-[120px] items-center justify-center rounded-xl border border-dashed text-xs text-muted-foreground">
        {t('oauth.batchSlotIdle')}
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border bg-background">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="font-mono text-[11px] text-muted-foreground">{row.i}</span>
        <span className="flex-1 truncate font-mono text-[11px]" title={row.name}>{row.name}</span>
        <span className="flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          {row.status === 'starting' ? t('oauth.batchStarting') : t('oauth.batchWaiting')}
        </span>
        {row.url && (
          <a
            href={row.url} target="_blank" rel="noopener noreferrer"
            title={t('oauth.batchOpenNew')}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

      {/* 粘贴模式才有的凭据条：授权页在跨域 iframe 里，脚本没法往里填值，
          所以只做到「一键复制」，剩下的由用户贴进登录弹窗 */}
      {row.secret && (
        <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5">
          <span className="flex-1 truncate font-mono text-[10px] text-muted-foreground" title={row.name}>
            {row.name}
          </span>
          <CopyChip label={t('oauth.batchCopyMail')} value={row.name} />
          <CopyChip label={t('oauth.batchCopyPwd')} value={row.secret} />
        </div>
      )}

      <div className="relative h-[520px] bg-muted/30">
        {row.url ? (
          // 必须关进沙箱。授权页是第三方页面，用户在其中点「用 Google 登录」后
          // 它常会做反嵌套跳转（`window.top.location = ...`）——点击带来的用户
          // 激活会让浏览器放行这次顶层导航，整个控制台被导航走，用户看到的就是
          // 「白屏，刷新才回来，再点又白屏」。
          // 沙箱里**不给** allow-top-navigation / allow-top-navigation-by-user-activation，
          // 它就只能改自己那个框，劫持不了宿主页面；剩下的开关是登录流程本身的
          // 需要（脚本、表单、Cookie、弹窗）。
          <iframe
            key={`${row.fid}-${reloadKey}`}
            src={row.url}
            title={row.name}
            className="h-full w-full border-0 bg-white"
            allow="clipboard-write; clipboard-read"
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-storage-access-by-user-activation"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t px-3 py-1.5">
        <span className="text-[10px] text-muted-foreground">{t('oauth.batchFrameHint')}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={onReload}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RotateCw className="h-3 w-3" />{t('oauth.batchReload')}
          </button>
          <button
            onClick={() => onSkip(row)}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <SkipForward className="h-3 w-3" />{t('oauth.batchSkip')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 队列里的小格子：只报状态，不挂 iframe。 */
function QueueChip({row, t, onRetry}: {row: Row; t: TFn; onRetry: () => void}) {
  const style = {
    queued: 'border-border text-muted-foreground',
    starting: 'border-blue-500/40 text-blue-600 dark:text-blue-400',
    active: 'border-blue-500 text-blue-600 dark:text-blue-400',
    ok: 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400',
    failed: 'border-destructive/50 text-destructive',
  }[row.status];

  const label = {
    queued: t('oauth.batchQueued'),
    starting: t('oauth.batchStarting'),
    active: t('oauth.batchWaiting'),
    ok: t('oauth.batchOk'),
    failed: t('oauth.batchFailed'),
  }[row.status];

  return (
    <button
      type="button"
      onClick={row.status === 'failed' ? onRetry : undefined}
      disabled={row.status !== 'failed'}
      title={row.detail || row.name}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]',
        style,
        row.status === 'failed' && 'cursor-pointer hover:bg-muted',
      )}
    >
      {row.status === 'ok' && <CheckCircle2 className="h-3 w-3" />}
      {row.status === 'failed' && <XCircle className="h-3 w-3" />}
      {(row.status === 'starting' || row.status === 'active') &&
        <Loader2 className="h-3 w-3 animate-spin" />}
      <span className="font-mono">{row.name}</span>
      <span className="opacity-70">
        {row.status === 'failed' ? t('oauth.batchRetry') : label}
      </span>
    </button>
  );
}

/** 复制一小段文本（邮箱/密码），结果如实回报——写不进剪贴板时不假装成功。 */
function CopyChip({label, value}: {label: string; value: string}) {
  const t = useT();

  const grab = async () => {
    if (await copyText(value)) notify.ok(t('common.copied'));
    else notify.warn(t('common.copyFailed'), t('common.manualCopy'));
  };

  return (
    <button
      type="button"
      onClick={grab}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <Copy className="h-3 w-3" />{label}
    </button>
  );
}
