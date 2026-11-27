## Версионирование BillOK (обязательно)

<!-- Перед заполнением прочитать AGENTS.md и docs/versioning.md. -->

- Issue / TASK-BILLOK:
- Тип (version:major / version:minor / version:patch):
- Предыдущая версия актуального main → новая версия:
- Обоснование типа:
- Согласование владельца (для MAJOR):

- [ ] Версия синхронно изменена в package.json и обоих корневых полях package-lock.json; зависимости не изменены ради номера.
- [ ] Серверный манифест src/server/lib/billok-release.json соответствует версии, TASK, русскому названию и номеру этого PR.
- [ ] CHANGELOG.md обновлён; повторная проверка/исправление невыпущенной задачи не повышают номер ещё раз.
- [ ] Проверено соответствие актуальному main.

## Summary

<!-- What does this PR do and why? -->

## Changes

<!-- Bullet list of what changed -->

## Test Plan

- [ ] `npm audit --omit=dev --audit-level=high` passes
- [ ] `npm run format:check` passes
- [ ] `npm run lint` passes
- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] `npm run test:docker` passes (Docker, entrypoint, `prisma/` SQL, or dependency changes)
- [ ] `npm run lint:i18n` passes (if UI text changed)
- [ ] Tested manually in the browser (describe what you clicked through)
- [ ] E2E tests added or updated (if applicable)

## Related Issues

<!-- Closes #123 -->
