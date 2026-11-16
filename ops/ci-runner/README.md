# BillOK — обслуживание ci-runner (Issue #1, 8.8)

Целевой сервер: msk-1-vm-0w12; сервис
actions.runner.kurt525-billok.msk-1-vm-0w12-billok.service.
Node.js 22.23.4 не удалять.

## Мониторинг

ci-runner-cleanup status без привилегий выводит свободное место на / и
/srv/ci-storage, проверяет монтирование рабочего каталога BillOK, сервис
GitHub runner и версию Node. Все пять обязательных CI jobs вызывают эту
проверку до выполнения основного задания. При >=80% диска — предупреждение,
при >=90%, отсутствии монтирования, Node или сервиса — ошибка.

На хосте работают таймеры ci-runner-disk-guard.timer (ежечасно),
ci-runner-cleanup.timer (ежедневно) и docker-ci-gc.timer (еженедельно).
pressure чистит при >=80% на любом из двух дисков; daily выполняет
ограниченную очистку. При активности любого Runner.Worker удаление откладывается.

## Изоляция очистки

Разрешены только:
- старые логи BillOK runner (/opt/actions-runner-billok/_diag/*.log);
- старые /tmp/billok-* за исключением путей Node, backup, deploy, release,
  secret, sign, keep и production; только без новых файлов за 24 часа,
  символических ссылок и монтирования внутри;
- Docker volumes только с именем billok-ci-temp-*, меткой
  billok.ci.ephemeral=true, без присоединённых контейнеров, старше 72 часов.

Удаление общих Docker images, build-cache, контейнеров или анонимных volumes
запрещено. Другие проекты и службы не затрагиваются. Если места всё ещё не
хватает, необходим ручной аудит, а не более агрессивный docker prune.

## Установка

Исходники: ops/ci-runner/. Перед установкой выполнить bash -n обоих файлов,
python3 scripts/test_ci_runner_maintenance.py и root dry-run:

    sudo env CI_CLEANUP_DRY_RUN=1 /usr/local/sbin/ci-runner-cleanup daily

Установка только с проверенного коммита с резервной копией каждого
/usr/local/sbin/ci-runner-cleanup и /usr/local/sbin/docker-ci-gc.
Системные таймеры не переустанавливать: после атомарной замены файлов
следующие запуски подхватят их.

Проверка:

    bash /usr/local/sbin/ci-runner-cleanup status
    systemctl list-timers --all
    systemctl is-active actions.runner.kurt525-billok.msk-1-vm-0w12-billok.service

При случайном сбое CI повторять только упавшее задание, без коммита,
если код не изменился. Checkbox в Issue #1 после 5/5 PASS;
отчёт по выполнению в описании PR #3.
