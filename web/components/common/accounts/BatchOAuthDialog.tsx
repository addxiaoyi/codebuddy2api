'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {useT, type TFn} from '@/lib/i18n/provider';
import {useRealm} from '@/lib/realm-context';
import {
  Loader2, CheckCircle2, XCircle, Play, ExternalLink, AlertTriangle, RotateCw,
} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {accountApi, errText} from '@/lib/api';
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
  name: string;                                // 备注
  fid: string;                                 // OAuth 会话 id
  url: string;                                 // 授权 url（iframe src）
  status: 'starting' | 'embedded' | 'ok' | 'failed';
  detail?: string;                             // nickname/uid 或错误
  startedMs?: number;
  poller?: number;
};

const POLL_MS = 2500;
const POLL_TIMEOUT_S = 300;
const MAX_N = 12;

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
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [rows, setRows] = useState<Row[]>([]);
  const [reloadKey, setReloadKey] = useState(0);   // 重载 iframe 用

  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = rows;

  const stopAllPolling = useCallback(() => {
    rowsRef.current.forEach((r) => r.poller && window.clearInterval(r.poller));
  }, []);

  useEffect(() => {
    if (!open) {
      stopAllPolling();
      setPhase('idle');
      setRows([]);
    }
  }, [open, stopAllPolling]);

  // 单行：建会话 + 开轮询
  const spawn = useCallback(async (i: number, version: 'cn' | 'intl', keep: boolean) => {
    const name = `${prefix}-${String(i).padStart(2, '0')}`;
    const pending: Row = {i, name, fid: '', url: '', status: 'starting'};
    setRows((prev) => [...prev, pending]);

    let r: {id: string; url: string};
    try {
      r = await accountApi.oauthStart(name, version, keep);
    } catch (e) {
      setRows((prev) =>
        prev.map((p) => (p.i === i ? {...p, status: 'failed', detail: errText(e)} : p)),
      );
      return;
    }

    const startedMs = Date.now();
    setRows((prev) =>
      prev.map((p) => (p.i === i ? {...p, ...r, status: 'embedded', startedMs} : p)),
    );

    const poller = window.setInterval(async () => {
      try {
        const s = await accountApi.oauthPoll(r.id);
        if (s.status === 'success') {
          window.clearInterval(poller);
          const sec = Math.round((Date.now() - startedMs) / 1000);
          const detail = [s.nickname && `@${s.nickname}`, s.uid, `${sec}s`]
            .filter(Boolean).join('  ·  ');
          setRows((prev) =>
            prev.map((p) => (p.i === i ? {...p, status: 'ok', detail} : p)),
          );
        } else if (s.status === 'expired' || s.status === 'invalid') {
          window.clearInterval(poller);
          setRows((prev) =>
            prev.map((p) => (p.i === i ? {...p, status: 'failed', detail: s.status} : p)),
          );
        } else if ((Date.now() - startedMs) / 1000 > POLL_TIMEOUT_S) {
          window.clearInterval(poller);
          setRows((prev) =>
            prev.map((p) => (p.i === i ? {...p, status: 'failed', detail: `timeout ${POLL_TIMEOUT_S}s`} : p)),
          );
        }
      } catch {
        // 网络抖动，下一轮再试
      }
    }, POLL_MS);

    setRows((prev) => prev.map((p) => (p.i === i ? {...p, poller} : p)));
  }, [prefix]);

  const start = async () => {
    stopAllPolling();
    setRows([]);
    setPhase('running');

    const n = Math.max(1, Math.min(MAX_N, count));
    const version = realm === 'global' ? 'intl' : 'cn';

    // 逐个建会话（错开 800ms，避免 Keycloak 同浏览器并发会话互相覆盖）。
    // 第 1 个 keep=false：顺手清掉上一轮遗留的会话，避免撞上服务端 16 个的上限；
    // 其余 keep=true：不然后建的会把先建的一起删掉，只剩最后一格能登录。
    for (let i = 1; i <= n; i++) {
      await spawn(i, version, i > 1);
      if (i < n) await new Promise((res) => setTimeout(res, 800));
    }
  };

  // 全部结束（成功或失败）后收尾
  useEffect(() => {
    if (phase !== 'running') return;
    const active = rows.filter((r) => r.status === 'starting' || r.status === 'embedded');
    if (rows.length > 0 && active.length === 0) {
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
  const total = Math.max(count, rows.length);
  const pct = total ? Math.round((done / total) * 100) : 0;

  const reloadFrames = () => setReloadKey((k) => k + 1);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) stopAllPolling();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-[1100px] w-[92vw]" showCloseButton>
        <DialogHeader>
          <DialogTitle>{t('oauth.batchTitle', {realm: realmName})}</DialogTitle>
          <DialogDescription>{t('oauth.batchDesc', {count})}</DialogDescription>
        </DialogHeader>

        <div className="flex w-full flex-col gap-4 px-6 pb-6">
          {/* 控制栏 */}
          <div className="flex items-end gap-3">
            <div className="w-[110px] space-y-1">
              <div className="text-[11px] font-medium">{t('oauth.batchCount')}</div>
              <Input
                type="number" min={1} max={MAX_N} value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="h-9 rounded-full text-xs"
                disabled={phase === 'running'}
              />
            </div>
            <div className="w-[160px] space-y-1">
              <div className="text-[11px] font-medium">{t('oauth.batchPrefix')}</div>
              <Input
                value={prefix} onChange={(e) => setPrefix(e.target.value)}
                className="h-9 rounded-full text-xs"
                disabled={phase === 'running'}
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

          {/* 提示 */}
          {rows.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
              <span>{t('oauth.batchEmbedHint')}</span>
            </div>
          )}

          {/* iframe 平铺网格 */}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-3 max-h-[62vh] overflow-y-auto pr-1">
            {rows.map((r) => (
              <FrameCard
                key={r.fid || `s-${r.i}`}
                row={r}
                t={t}
                reloadKey={reloadKey}
                onReload={reloadFrames}
              />
            ))}

            {phase === 'idle' && (
              <div className="col-span-full flex items-center justify-center py-12 text-sm text-muted-foreground">
                {t('oauth.batchIdleHint')}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FrameCard({
  row, t, reloadKey, onReload,
}: {
  row: Row;
  t: TFn;
  reloadKey: number;
  onReload: () => void;
}) {
  const badge = {
    starting: {cls: 'bg-muted text-muted-foreground', icon: <Loader2 className="h-3 w-3 animate-spin" />, label: t('oauth.batchStarting')},
    embedded: {cls: 'bg-blue-500/10 text-blue-600 dark:text-blue-400', icon: <Loader2 className="h-3 w-3 animate-spin" />, label: t('oauth.batchWaiting')},
    ok: {cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', icon: <CheckCircle2 className="h-3 w-3" />, label: t('oauth.batchOk')},
    failed: {cls: 'bg-destructive/10 text-destructive', icon: <XCircle className="h-3 w-3" />, label: t('oauth.batchFailed')},
  }[row.status];

  const showFrame = row.status === 'embedded' && row.url;

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border bg-background">
      {/* 卡片头 */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="font-mono text-[11px] text-muted-foreground">{row.i}</span>
        <span className="flex-1 truncate font-mono text-[11px]" title={row.fid}>{row.name}</span>
        <span className={cn('flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium', badge.cls)}>
          {badge.icon}
          {badge.label}
        </span>
        {row.url && (
          <a
            href={row.url}
            target="_blank"
            rel="noopener noreferrer"
            title={t('oauth.batchOpenNew')}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

      {/* 卡片体：iframe 或结果 */}
      <div className="relative h-[440px] bg-muted/30">
        {showFrame ? (
          <iframe
            key={`${row.fid}-${reloadKey}`}
            src={row.url}
            title={row.name}
            className="h-full w-full border-0 bg-white"
            allow="clipboard-write; clipboard-read"
          />
        ) : row.status === 'ok' ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            <div className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
              {t('oauth.batchOk')}
            </div>
            {row.detail && (
              <div className="font-mono text-[11px] text-muted-foreground break-all">{row.detail}</div>
            )}
          </div>
        ) : row.status === 'failed' ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <XCircle className="h-8 w-8 text-destructive" />
            <div className="text-xs font-medium text-destructive">{t('oauth.batchFailed')}</div>
            {row.detail && (
              <div className="font-mono text-[11px] text-muted-foreground break-all">{row.detail}</div>
            )}
            {row.url && (
              <a
                href={row.url} target="_blank" rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-blue-500 hover:underline"
              >
                <ExternalLink className="h-3 w-3" />{t('oauth.batchOpenNew')}
              </a>
            )}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>

      {/* 卡片脚：重载 */}
      {showFrame && (
        <div className="flex items-center justify-between border-t px-3 py-1.5">
          <span className="text-[10px] text-muted-foreground">{t('oauth.batchFrameHint')}</span>
          <button
            onClick={onReload}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RotateCw className="h-3 w-3" />{t('oauth.batchReload')}
          </button>
        </div>
      )}
    </div>
  );
}
