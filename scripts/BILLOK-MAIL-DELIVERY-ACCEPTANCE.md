# BillOK — приёмка отправки писем REG.RU (Issue #1, 7.3)

Проверка запускается **только вручную** на VPS с доступом к
mail.hosting.reg.ru (например, msk-1-vm-xsm6). CI не отправляет реальные письма.

## Перед началом

1. В REG.RU должен существовать ящик noreply@billok.ru.
2. Пароль хранится **вне Git** в файле /etc/billok/secrets/reg-ru-smtp-password,
   принадлежащем root (или пользователю, запускающему инструмент), с правами
   **0600**. Нельзя вводить пароль в чате, команде или логе.
3. Владелец создаёт файл вручную на VPS. Скрипт не создаёт рабочие учётные
   записи, не меняет настройки почты и не развёртывает BillOK.

## 1. Доставка внутри REG.RU (SMTP + IMAP)

Запускать из каталога актуальных исходников BillOK:

```bash
sudo env BILLOK_REAL_SMTP_TEST=1 \
  BILLOK_MAIL_PASSWORD_FILE=/etc/billok/secrets/reg-ru-smtp-password \
  python3 scripts/billok_mail_delivery_check.py \
  --send --to noreply@billok.ru --check-own-inbox
```

Проверяются SMTP AUTH по TLS на 465, принятие письма и поиск по IMAP 993
только заголовков нового сообщения во «Входящих» и «Спаме». Чужие письма
и их содержимое не считываются. Контрольное сообщение **не содержит
Passkey-токенов**. Если внутри одного домена сервер не формирует
Authentication-Results, печатается NOT_PRESENT, а не ложный PASS.

## 2. Внешняя доставка, папка «Спам», SPF/DKIM/DMARC

Нужен собственный контролируемый внешний ящик в зоне .ru или .su.
Замените адрес получателя в команде:

```bash
sudo env BILLOK_REAL_SMTP_TEST=1 \
  BILLOK_MAIL_PASSWORD_FILE=/etc/billok/secrets/reg-ru-smtp-password \
  python3 scripts/billok_mail_delivery_check.py \
  --send --to recipient@mail.ru
```

После SMTP_ACCEPTED=PASS вручную проверьте **«Входящие» и «Спам»**
внешнего ящика. В оригинальных заголовках полученного сообщения
необходимо проверить spf=pass, dkim=pass, dmarc=pass, выравнивание
From с billok.ru и DKIM d=billok.ru. При отсутствии нужных заголовков
нельзя считать проверку успешной.

SMTP_ACCEPTED означает приём сервером SMTP, а **не доставку**.

## Приёмка

Без SMTP AUTH, фактического получения и проверки папки/заголовков
у внешнего адресата Issue #1, 7.3 остаётся открытым.
Контрольная отправка не является авторизацией в BillOK и не заменяет Passkey.
