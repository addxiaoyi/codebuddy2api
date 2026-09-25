'use client';

import {useEffect, useRef, useState} from 'react';
import {useT} from '@/lib/i18n/provider';
import {useRealm} from '@/lib/realm-context';
import {Loader2, CheckCircle2, XCircle, Play, Clock} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {accountApi, errText} from '@/lib/api';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
} from '@/components/animate-ui/radix/dialog';

type Phase = 'idle' | 'running' | 'done' | 'error';
type JobStatus = 'running' | 'done' | 'partial' | 'error';

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
  const [phase, setPhase] = useState<Phase>('idle');
  const [jobId, setJobId] = useState('');
  const [job, setJob] = useState<{
    status: JobStatus; count: number; ok: number; failed: number;
    progress: number; accounts: any[]; errors: any[];
    started_at?: number; finished_at?: number;
  } | null>(null);
  const [err, setErr] = useState('');
  const timerRef = useRef<number | null>(null);

  const stopPoll = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    if (!open) {
      stopPoll();
      setPhase('idle');
      setJobId('');
      setJob(null);
      setErr('');
    }
  }, [open]);

  const start = async () => {
    setErr('');
    setPhase('running');
    try {
      const r = await accountApi.oauthBatchStart(
        Math.max(1, Math.min(50, count)),
        realm === 'global' ? 'intl' : 'cn',
        prefix || 'batch',
        true,
      );
      setJobId(r.job_id);

      timerRef.current = window.setInterval(async () => {
        try {
          const s = await accountApi.oauthBatchStatus(r.job_id);
          setJob(s);
          if (s.status !== 'running') {
            stopPoll();
            if (s.status === 'done') {
              setPhase('done');
              onSuccess?.();
              window.dispatchEvent(new Event('workbuddy-manager:accounts-changed'));
            } else {
              setPhase('error');
              setErr((s.errors?.[0]?.error || s.status).slice(0, 200));
            }
          }
        } catch (e) {
          stopPoll();
          setPhase('error');
          setErr(errText(e));
        }
      }, 2000);
    } catch (e) {
      setPhase('error');
      setErr(errText(e));
    }
  };

  const elapsed = job?.started_at
    ? Math.round(((job.finished_at || Date.now() / 1000) - job.started_at))
    : 0;

  const pct = job ? Math.round((job.progress / job.count) * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[460px]" showCloseButton>
        <DialogHeader>
          <DialogTitle>{t('oauth.batchTitle', {realm: realmName})}</DialogTitle>
          <DialogDescription>{t('oauth.batchDesc')}</DialogDescription>
        </DialogHeader>

        <div className="flex w-full flex-col gap-4 px-6 pb-6">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium">{t('oauth.batchCount')}</div>
              <Input
                type="number" min={1} max={50}
                value={count} onChange={(e) => setCount(Number(e.target.value))}
                className="h-9 rounded-full text-xs"
                disabled={phase === 'running'}
              />
              <div className="text-[10px] text-muted-foreground">{t('oauth.batchCountHint')}</div>
            </div>
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium">{t('oauth.batchPrefix')}</div>
              <Input
                value={prefix} onChange={(e) => setPrefix(e.target.value)}
                className="h-9 rounded-full text-xs"
                disabled={phase === 'running'}
              />
            </div>
          </div>

          {/* 进度 / 结果区 */}
          {phase === 'idle' && (
            <div className="rounded-xl bg-muted/50 p-3 text-[11px] text-muted-foreground leading-relaxed">
              <div className="font-medium text-foreground mb-1">⚠️ {t('oauth.batchProfile')}</div>
              {t('oauth.batchNeedSetup')}
              <div className="mt-2 font-mono text-[10px] bg-black/5 dark:bg-white/5 rounded px-2 py-1">
                ~/.workbuddy/google-chromium/
              </div>
            </div>
          )}

          {phase === 'running' && job && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t('oauth.batchRunning')}
                </span>
                <span className="font-mono text-[11px]">
                  {job.ok}/{job.count} <span className="text-muted-foreground">ok</span>
                  {job.failed > 0 && <span className="text-amber-500"> · {job.failed} fail</span>}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-gradient-to-r from-blue-400 to-indigo-500 transition-all" style={{width: `${pct}%`}} />
              </div>
              <div className="text-[10px] text-muted-foreground font-mono truncate">job_id={jobId}</div>
            </div>
          )}

          {phase === 'done' && job && (
            <div className="flex items-start gap-2 rounded-xl bg-emerald-500/10 p-3">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500 mt-0.5" />
              <div className="text-xs">
                <div className="font-medium text-emerald-600 dark:text-emerald-400">{t('oauth.batchDone')}</div>
                <div className="text-muted-foreground">
                  {t('oauth.batchDoneDetail', {ok: job.ok, failed: job.failed, sec: elapsed})}
                </div>
                {job.accounts?.length > 0 && (
                  <div className="mt-1 text-[11px] font-mono text-muted-foreground">
                    {job.accounts.map((a: any) => a.nickname || a.uid || a.name).join(', ')}
                  </div>
                )}
              </div>
            </div>
          )}

          {phase === 'error' && (
            <div className="flex items-start gap-2 rounded-xl bg-destructive/10 p-3">
              <XCircle className="h-4 w-4 shrink-0 text-destructive mt-0.5" />
              <div className="text-xs">
                <div className="font-medium text-destructive">{t('oauth.batchError', {err: err.slice(0, 60)})}</div>
                {err && err !== 'Broken pipe' && (
                  <div className="text-muted-foreground font-mono text-[11px] mt-1">{err}</div>
                )}
                {err === 'Broken pipe' && (
                  <div className="text-muted-foreground text-[11px] mt-1">
                    后端机器可能没外网到 Google，或者 Google profile 过期了。先跑 setup 再批量。
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex w-full gap-2 pt-2">
            <Button
              variant="outline" className="flex-1 rounded-full"
              onClick={() => onOpenChange(false)}
              disabled={phase === 'running'}
            >
              {t('common.cancel')}
            </Button>
            {(phase === 'idle' || phase === 'error') && (
              <Button className="flex-1 rounded-full gap-1.5" onClick={start}>
                <Play className="h-3.5 w-3.5" />
                {t('oauth.batchStart')}
              </Button>
            )}
            {phase === 'done' && (
              <Button className="flex-1 rounded-full" onClick={() => onOpenChange(false)}>
                {t('common.close')}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
