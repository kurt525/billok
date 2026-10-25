import { describe, test, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import en from '../../../messages/en/errors.json';
import ru from '../../../messages/ru/errors.json';
import { AppError, errorShape, userErrorMessage } from './app-error';

// #266: server errors reached every locale in English
describe('AppError', () => {
  test('carries its key and values, with the English text as its message for logs and API callers', () => {
    const error = new AppError('BAD_REQUEST', 'leaveWithBalance');
    expect(error).toBeInstanceOf(TRPCError);
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.messageKey).toBe('leaveWithBalance');
    expect(error.message).toBe('You still owe or are owed money in this group. Settle up before you leave.');

    const withValues = new AppError('BAD_REQUEST', 'sessionFull', { max: 100 });
    expect(withValues.messageValues).toEqual({ max: 100 });
    expect(withValues.message).toBe('Maximum 100 people per session');
  });
});

describe('userErrorMessage', () => {
  test("is the error's text in the page's language", () => {
    expect(userErrorMessage(new AppError('BAD_REQUEST', 'leaveWithBalance'), 'ru')).toBe(ru.leaveWithBalance);
    expect(ru.leaveWithBalance).not.toBe(en.leaveWithBalance);
    expect(userErrorMessage(new AppError('BAD_REQUEST', 'sessionFull', { max: 100 }), 'ru')).toBe(
      ru.sessionFull.replace('{max}', '100'),
    );
  });

  test("an error without a key gets its code's general message, never its own English text", () => {
    const internal = new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Invalid `prisma.user.update()` invocation',
    });
    expect(userErrorMessage(internal, 'ru')).toBe(ru.generic.other);
    expect(userErrorMessage(new TRPCError({ code: 'NOT_FOUND' }), 'ru')).toBe(ru.generic.notFound);
    expect(userErrorMessage(new TRPCError({ code: 'UNAUTHORIZED' }), 'ru')).toBe(ru.generic.unauthorized);
    expect(userErrorMessage(new TRPCError({ code: 'TOO_MANY_REQUESTS' }), 'ru')).toBe(ru.generic.tooManyRequests);
  });

  test('input that fails validation gets the general bad-request message, not the validator output', () => {
    const parsed = z.object({ name: z.string() }).safeParse({ name: 1 });
    const invalid = new TRPCError({ code: 'BAD_REQUEST', cause: parsed.error });
    expect(invalid.message).toContain('expected string');
    expect(userErrorMessage(invalid, 'ru')).toBe(ru.generic.badRequest);
  });
});

describe('errorShape', () => {
  const shape = {
    message: 'Session not found',
    code: -32004,
    data: { code: 'NOT_FOUND' as const, httpStatus: 404, path: 'guest.getSession' },
  };

  test('swaps in the translated message and adds the key the client can branch on', () => {
    const formatted = errorShape(shape, new AppError('NOT_FOUND', 'sessionNotFound'), 'ru');
    expect(formatted.message).toBe(ru.sessionNotFound);
    expect(formatted.data).toEqual({ ...shape.data, messageKey: 'sessionNotFound' });
    expect(formatted.code).toBe(shape.code);
  });

  test('an error without a key has a null messageKey', () => {
    const formatted = errorShape(shape, new TRPCError({ code: 'NOT_FOUND' }), 'ru');
    expect(formatted.message).toBe(ru.generic.notFound);
    expect(formatted.data.messageKey).toBeNull();
  });
});
