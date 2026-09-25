'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {useT} from '@/lib/i18n/provider';
import {useRealm} from '@/lib/realm-context';
import {Loader2, CheckCircle2, XCircle, Play, ExternalLink, CircleDot, AlertTriangle} from 'lucide-react';
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
  i: number;            // 1-based
  name: string;         // 备注
  fid: string;          // OAuth 会话 id
  url: string;          // workbuddy 授权 url
  status: 'pending' | 'waiting_popup' | 'polling' | 'ok' | 'failed';
  detail?: string;       // nickname / uid / error message
  popup?: Window | null; // 弹窗对象
  poller?: number;      // poll interval id
  pollStartMs?: number;
};

const POPUP_W = 440;
const POPUP_H = 660;
const POPUP_FEATURES =
  'menubar=no,toolbar=no,location=yes,resizable=yes,scrollbars=yes' +
  `,width=${POPUP_W},height=${POPUP_H}`;

const POLL_TIMEOUT_SEC = 300;
const POLL_INTERVAL_MS = 2500;

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

  const [count, setCount] = useState(5);
  const [prefix, setPrefix] = useState('batch');
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [rows, setRows] = useState<Row[]>([]);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [topErr, setTopErr] = useState('');

  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = rows;

  // close 弹窗时清理所有 poller / window
  const cleanupAll = useCallback(() => {
    rowsRef.current.forEach((r) => {
      if (r.poller) window.clearInterval(r.poller);
      if (r.popup && !r.popup.closed) {
        try { r.popup.close(); } catch {}
      }
    });
  }, []);

  useEffect(() => {
    if (!open) {
      cleanupAll();
      setPhase('idle');
      setRows([]);
      setPopupBlocked(false);
      setTopErr('');
    }
  }, [open, cleanupAll]);

  // 每轮启动一个 OAuth + window.open + poller
  const runOne = useCallback(async (i: number) => {
    const name = `${prefix}-${String(i).padStart(2, '0')}`;
    let row: Row = {
      i, name, fid: '', url: '',
      status: 'pending',
    };

    // 1. 启动 OAuth
    try {
      const r = await accountApi.oauthStart(
        name,
        realm === 'global' ? 'intl' : 'cn',
      );
      row.fid = r.id;
      row.url = r.url;
      row.status = 'waiting_popup';
    } catch (e) {
      row.status = 'failed';
      row.detail = errText(e);
      setRows((prev) => [...prev, row]);
      return false;
    }

    setRows((prev) => [...prev, row]);

    // 2. window.open 授权弹窗
    try {
      const win = window.open(row.url, `oauth-${row.fid}`, POPUP_FEATURES);
      if (!win) {
        setPopupBlocked(true);
        row.status = 'failed';
        row.detail = t('oauth.batchWarningPopup');
        setRows((prev) =>
          prev.map((p) => (p.fid === row.fid ? {...p, status: 'failed', detail: row.detail} : p)),
        );
        return false;
      }
      row.popup = win;
      row.pollStartMs = Date.now();
    } catch (e) {
      row.status = 'failed';
      row.detail = errText(e);
      setRows((prev) =>
        prev.map((p) => (p.fid === row.fid ? {...p, status: 'failed', detail: row.detail} : p)),
      );
      return false;
    }

    // 3. 开 poller
    row.status = 'polling';
    setRows((prev) =>
      prev.map((p) => (p.fid === row.fid ? {...p, status: 'polling'} : p)),
    );

    const poller = window.setInterval(async () => {
      try {
        const s = await accountApi.oauthPoll(row.fid);
        if (s.status === 'success') {
          window.clearInterval(poller);
          const elapsed = Math.round((Date.now() - (row.pollStartMs || Date.now())) / 1000);
          const detail =
            (s.nickname ? `@${s.nickname}` : '') +
            (s.uid ? `  ·  ${s.uid}` : '') +
            (elapsed ? `  ·  ${elapsed}s` : '');
          setRows((prev) =>
            prev.map((p) =>
              p.fid === row.fid ? {...p, status: 'ok', detail} : p,
            ),
          );
          // 尽量关闭弹窗
          if (row.popup && !row.popup.closed) {
            try { row.popup.close(); } catch {}
          }
        } else if (s.status === 'expired' || s.status === 'invalid') {
          window.clearInterval(poller);
          setRows((prev) =>
            prev.map((p) =>
              p.fid === row.fid
                ? {...p, status: 'failed', detail: `会话 ${s.status}`}
                : p,
            ),
          );
        } else {
          // 继续 pending — 同时兜底超时
          const elapsed = Math.round((Date.now() - (row.pollStartMs || Date.now())) / 1000);
          if (elapsed > POLL_TIMEOUT_SEC) {
            window.clearInterval(poller);
            setRows((prev) =>
              prev.map((p) =>
                p.fid === row.fid
                  ? {...p, status: 'failed', detail: `超时 ${POLL_TIMEOUT_SEC}s`}
                  : p,
              ),
            );
          }
        }
      } catch {
        // poll 短暂失败（网络抖动）就静默等下一轮
      }
    }, POLL_INTERVAL_MS);

    row.poller = poller;
    return true;
  }, [prefix, realm, t]);

  const startAll = async () => {
    setTopErr('');
    setPopupBlocked(false);
    setRows([]);
    setPhase('running');

    const n = Math.max(1, Math.min(20, count));
    let okCount = 0;
    let failCount = 0;
    const startedAt = Date.now();

    for (let i = 1; i <= n; i++) {
      const ok = await runOne(i);
      if (ok) {
        // 等用户点授权的时间 —— 2s 后再开下一个，避免弹窗风暴
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        failCount++;
      }
    }

    // 等所有 poller 停（最多 5min）
    const maxWaitMs = POLL_TIMEOUT_SEC * 1000 + 5000;
    const allDone = () => rowsRef.current.every((r) => r.status === 'ok' || r.status === 'failed');
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline && !allDone()) {
      await new Promise((r) => setTimeout(r, 1000));
    }

    okCount = rowsRef.current.filter((r) => r.status === 'ok').length;
    failCount = rowsRef.current.filter((r) => r.status === 'failed').length;

    const sec = Math.round((Date.now() - startedAt) / 1000);
    setPhase('done');
    if (okCount > 0) {
      onSuccess?.();
      window.dispatchEvent(new Event('workbuddy-manager:accounts-changed'));
    } else {
      setTopErr(t('oauth.batchDoneDetail', {ok: 0, failed: n, sec}));
    }
  };

  const ok = rows.filter((r) => r.status === 'ok').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const total = rows.length;
  const pct = total ? Math.round((ok / Math.max(count, 1)) * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={(v) => {
      if (!v) cleanupAll();
      onOpenChange(v);
    }}>
      <DialogContent className="max-w-[560px]" showCloseButton>
        <DialogHeader>
          <DialogTitle>{t('oauth.batchTitle', {realm: realmName})}</DialogTitle>
          <DialogDescription>
            {t('oauth.batchDesc', {count})}
          </DialogDescription>
        </DialogHeader>

        <div className="flex w-full flex-col gap-4 px-6 pb-6">
          {/* 输入区 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium">{t('oauth.batchCount')}</div>
              <Input
                type="number" min={1} max={20}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="h-9 rounded-full text-xs"
                disabled={phase === 'running'}
              />
              <div className="text-[10px] text-muted-foreground">{t('oauth.batchCountHint')}</div>
            </div>
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium">{t('oauth.batchPrefix')}</div>
              <Input
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                className="h-9 rounded-full text-xs"
                disabled={phase === 'running'}
              />
            </div>
          </div>

          {/* 弹窗拦截警告 */}
          {popupBlocked && phase !== 'idle' && (
            <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 p-3 text-xs">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
              <div className="text-amber-600 dark:text-amber-400">{t('oauth.batchWarningPopup')}</div>
            </div>
          )}

          {/* 表头 */}
          {rows.length > 0 && (
            <div className="grid grid-cols-[28px_1fr_1fr_40px] gap-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-2">
              <span>#</span>
              <span>{t('oauth.batchEachName')}</span>
              <span>{t('oauth.batchEachStatus')}</span>
              <span></span>
            </div>
          )}

          {/* 每行 */}
          <div className="flex flex-col gap-1 max-h-[280px] overflow-y-auto pr-1">
            {rows.map((r) => (
              <RowLine key={r.fid || r.i} row={r} t={t} />
            ))}
            {phase === 'idle' && (
              <div className="text-[11px] text-muted-foreground text-center py-4">
                {t('oauth.batchPending')}
              </div>
            )}
          </div>

          {/* 进度条 / 结果条 */}
          {(phase === 'running' || phase === 'done') && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  {phase === 'running' ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {t('oauth.batchRunning', {n: total, count})}
                    </>
                  ) : failed === 0 ? (
                    <>
                      <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                      {t('oauth.batchDone')}
                    </>
                  ) : (
                    <>
                      <XCircle className="h-3 w-3 text-amber-500" />
                      {t('oauth.batchDoneDetail', {ok, failed, sec: 0})}
                    </>
                  )}
                </span>
                <span className="font-mono text-[11px]">
                  <span className="text-emerald-500">{ok}</span>
                  <span className="text-muted-foreground"> / {count}</span>
                  {failed > 0 && <span className="text-amber-500 ml-2">· {failed} fail</span>}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full transition-all',
                    failed > 0 ? 'bg-gradient-to-r from-amber-400 to-rose-500'
                               : 'bg-gradient-to-r from-blue-400 to-emerald-500',
                  )}
                  style={{width: `${pct}%`}}
                />
              </div>
            </div>
          )}

          {/* 顶部异常 */}
          {topErr && (
            <div className="flex items-start gap-2 rounded-xl bg-destructive/10 p-3 text-xs">
              <XCircle className="h-4 w-4 shrink-0 text-destructive mt-0.5" />
              <div className="font-mono text-[11px] text-destructive">{topErr}</div>
            </div>
          )}

          {/* 按钮 */}
          <div className="flex w-full gap-2 pt-2">
            <Button
              variant="outline" className="flex-1 rounded-full"
              onClick={() => { cleanupAll(); onOpenChange(false); }}
              disabled={phase === 'running'}
            >
              {t('common.cancel')}
            </Button>
            {(phase === 'idle' || phase === 'done') && (
              <Button className="flex-1 rounded-full gap-1.5" onClick={startAll}>
                <Play className="h-3.5 w-3.5" />
                {t('oauth.batchStart')}
              </Button>
            )}
            {phase === 'running' && (
              <Button className="flex-1 rounded-full gap-1.5" disabled>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('oauth.batchRunning', {n: total, count})}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── 单行状态组件 ──

function RowLine({row, t}: {row: Row; t: (k: string, p?: any) => string}) {
  const icon =
    row.status === 'ok'       ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> :
    row.status === 'failed'    ? <XCircle className="h-3.5 w-3.5 text-destructive" /> :
    row.status === 'polling'   ? <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" /> :
                                 <CircleDot className="h-3.5 w-3.5 text-muted-foreground" />;

  const statusText =
    row.status === 'ok'       ? (row.detail || t('oauth.batchOk')) :
    row.status === 'failed'   ? (row.detail || t('oauth.batchFailed')) :
    row.status === 'polling'  ? t('oauth.batchEachPolling') :
                                t('oauth.batchPending');

  return (
    <div className="grid grid-cols-[28px_1fr_1fr_40px] gap-2 items-center px-2 py-1.5 rounded-md text-[11px] hover:bg-muted/50 transition-colors">
      <span className="text-muted-foreground font-mono">{row.i}</span>
      <span className="font-mono truncate" title={row.fid}>{row.name}</span>
      <span className={cn(
        'flex items-center gap-1.5 truncate',
        row.status === 'ok' && 'text-emerald-600 dark:text-emerald-400',
        row.status === 'failed' && 'text-destructive',
        row.status === 'polling' && 'text-blue-600 dark:text-blue-400',
      )}>
        {icon}
        <span className="truncate" title={statusText}>{statusText}</span>
      </span>
      {row.status !== 'ok' && row.status !== 'failed' && row.url && (
        <a
          href={row.url}
          target={`oauth-${row.fid}`}
          rel="noopener"
          title={t('oauth.batchEachLinkLabel')}
          className="inline-flex items-center justify-center rounded-full p-1 hover:bg-muted text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}
