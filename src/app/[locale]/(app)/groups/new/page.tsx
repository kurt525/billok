'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';
import { localizedTrpcError } from '@/lib/localized-trpc-error';

const EMOJI_OPTIONS = ['💰', '🏠', '✈️', '🍽️', '🎉', '🛒', '🚗', '💼'];

export default function NewGroupPage() {
  const t = useTranslations('groups.new');
  const tc = useTranslations('common');
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [emoji, setEmoji] = useState('💰');

  const createGroup = trpc.groups.create.useMutation({
    onSuccess: (group) => {
      router.push(`/groups/${group.id}`);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    createGroup.mutate({
      name: name.trim(),
      description: description || undefined,
      currency: 'RUB',
      emoji,
    });
  }

  return (
    <div className="mx-auto min-w-0 max-w-lg">
      <h1 className="mb-6 text-2xl font-bold">{t('title')}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{t('details')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('name')}</Label>
              <Input
                id="name"
                className="h-11 min-w-0 text-base"
                placeholder={t('namePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={100}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">{t('description')}</Label>
              <Input
                id="description"
                className="h-11 min-w-0 text-base"
                placeholder={t('descriptionPlaceholder')}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
              />
            </div>

            <div className="space-y-2">
              <Label>{t('icon')}</Label>
              <div className="flex flex-wrap gap-2">
                {EMOJI_OPTIONS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    aria-label={e}
                    aria-pressed={emoji === e}
                    onClick={() => setEmoji(e)}
                    className={`flex size-11 shrink-0 items-center justify-center rounded-md border text-lg transition-colors ${
                      emoji === e ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted'
                    }`}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>

            {createGroup.error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {localizedTrpcError(createGroup.error, tc('errors.generic'))}
              </div>
            )}

            <Button type="submit" className="min-h-11 w-full text-base" disabled={createGroup.isPending}>
              {createGroup.isPending ? t('submitting') : t('submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
