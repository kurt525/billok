'use client';

import { type ComponentProps } from 'react';
import { Input } from '@/components/ui/input';
import { isSbpPhoneDraft } from '@/lib/sbp-banks';

type Props = Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'onPaste' | 'maxLength' | 'type'> & {
  value: string;
  onValueChange: (value: string) => void;
  onRejected: (source: 'typing' | 'paste') => void;
};

/** Shared controlled input. Rejects invalid keyboard and clipboard edits
 * rather than silently stripping or truncating digits. */
export function SbpPhoneInput({ value, onValueChange, onRejected, ...props }: Props) {
  return (
    <Input
      {...props}
      type="tel"
      inputMode="tel"
      maxLength={12}
      value={value}
      onChange={(event) => {
        const next = event.target.value;
        if (isSbpPhoneDraft(next)) {
          onValueChange(next);
        } else {
          // Restore even when the rejection banner is already visible and
          // another keypress does not cause a React state transition.
          event.currentTarget.value = value;
          onRejected('typing');
        }
      }}
      onPaste={(event) => {
        const input = event.currentTarget;
        const start = input.selectionStart ?? value.length;
        const end = input.selectionEnd ?? start;
        const next = value.slice(0, start) + event.clipboardData.getData('text') + value.slice(end);
        if (!isSbpPhoneDraft(next)) {
          event.preventDefault();
          onRejected('paste');
        }
      }}
    />
  );
}
