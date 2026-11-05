'use client';

import { useState, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, Megaphone } from 'lucide-react';

export function AnnouncementSection() {
  const t = useTranslations('admin');
  const utils = trpc.useUtils();
  const announcement = trpc.admin.getAnnouncement.useQuery();
  const setAnnouncement = trpc.admin.setAnnouncement.useMutation({
    onSuccess: () => {
      utils.admin.getAnnouncement.invalidate();
      utils.admin.getAuditLog.invalidate();
    },
  });

  const [draft, setDraft] = useState('');
  const lastSyncedRef = useRef<string | null>(null);

  // Sync draft from server data without useEffect
  const serverMessage = announcement.data?.message ?? '';
  if (serverMessage !== lastSyncedRef.current) {
    lastSyncedRef.current = serverMessage;
    if (serverMessage && draft !== serverMessage) {
      setDraft(serverMessage);
    }
  }

  return (
    <section className="min-w-0" data-testid="admin-announcement-section">
      <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2">
        <Megaphone className="h-5 w-5 text-muted-foreground" />
        <h2 className="min-w-0 text-lg font-semibold [overflow-wrap:anywhere]">{t('announcement.title')}</h2>
      </div>

      <Card className="min-w-0">
        <CardHeader className="min-w-0 pb-2">
          <CardTitle className="min-w-0 text-sm font-medium text-muted-foreground [overflow-wrap:anywhere]">
            {announcement.data?.message ? t('announcement.showing') : t('announcement.noActive')}
          </CardTitle>
        </CardHeader>
        <CardContent className="min-w-0 space-y-3">
          <textarea
            data-testid="admin-announcement-input"
            aria-label={t('announcement.placeholder')}
            className="min-h-28 w-full min-w-0 max-w-full scroll-mt-20 resize-y rounded-md border bg-background px-3 py-2 text-base [overflow-wrap:anywhere] focus:outline-none focus:ring-2 focus:ring-ring"
            rows={3}
            placeholder={t('announcement.placeholder')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={500}
          />
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span
              className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]"
              data-testid="admin-announcement-counter"
            >
              {t('announcement.charCount', { count: draft.length })}
            </span>
            <div className="flex min-w-0 flex-wrap gap-2">
              {announcement.data?.message && (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="admin-announcement-clear"
                  className="min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]"
                  disabled={setAnnouncement.isPending}
                  onClick={() => {
                    setAnnouncement.mutate({ message: '' });
                    setDraft('');
                  }}
                >
                  {t('announcement.clear')}
                </Button>
              )}
              <Button
                size="sm"
                data-testid="admin-announcement-save"
                className="min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]"
                disabled={setAnnouncement.isPending || draft.trim() === (announcement.data?.message ?? '')}
                onClick={() => setAnnouncement.mutate({ message: draft.trim() })}
              >
                {setAnnouncement.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                {t('announcement.save')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
