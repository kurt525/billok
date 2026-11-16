# BillOK — Nginx, Let's Encrypt, доступ только через reverse proxy (8.10)

**Статус: подготовка, сайт НЕ опубликован.** Документ не разрешает запуск
production. До приёмки приложения и согласования владельцем нельзя включать
публичный BillOK или продвигать образы. Публикация отдельно от настройки
production-секретов (8.11).

## Проверенная инфраструктура (16.11.2026)

- VPS: msk-1-vm-xsm6; внешний IPv4 89.169.2.31.
- A-запись billok.ru указывает на 89.169.2.31, AAAA отсутствует.
- www.billok.ru не имеет A/AAAA, поэтому не входит в сертификат.
- На сервере работает Nginx. HTTP billok.ru сейчас отвечает 404, HTTPS
  ещё не имеет сертификата для billok.ru и попадает на другой virtual host.
- На VPS есть другие сайты, включая mta-sts.billok.ru: нельзя менять их
  конфигурации, сертификаты и контейнеры.
- У SentinelX нет прав root на установку сертификата и Nginx vhost;
  ниже описаны **будущие** действия администратора после разрешения владельца.

## Защита внутреннего порта

В docker/docker-compose.yml порт приложения привязан только к
127.0.0.1, а не к 0.0.0.0, :: или внешнему IP. Для подготовленного Nginx
нужен BILLOK_INTERNAL_PORT=3000. Реальная среда должна задавать
NEXTAUTH_URL=https://billok.ru и доверие к проверенному reverse proxy.
Секреты и другие переменные — предмет 8.11.
Запрещён внешний firewall/NAT port-forward на 3000/TCP.

## Этап A — сертификат без запуска приложения

1. Сверить A-запись billok.ru, отсутствие другого server_name billok.ru,
   свободные 80/443. Не изменять соседние сайты.
2. Создать изолированный /var/www/billok-acme с доступом для Nginx.
3. Скопировать ops/billok/nginx/billok-acme.conf в
   /etc/nginx/sites-available/billok-acme.conf, создать symlink в
   /etc/nginx/sites-enabled. Не включать одновременно два BillOK vhost.
4. Выполнить nginx -t, только после успеха — systemctl reload nginx.
   Этот virtual host возвращает 404 кроме ACME challenge; приложение
   не опубликовано.
5. Только с согласия владельца выпустить сертификат для billok.ru.
   Пример (root, указать реальный контактный e-mail администратора):

       certbot certonly --webroot --webroot-path /var/www/billok-acme --cert-name billok.ru --domains billok.ru --non-interactive --agree-tos --email ADMIN_EMAIL_FOR_CERTBOT

6. Проверить /etc/letsencrypt/live/billok.ru/fullchain.pem,
   privkey.pem и certbot renew --dry-run. Приложение всё ещё не опубликовано.

## Этап B — HTTPS после разрешения владельца

1. Убедиться, что сертификат Let's Encrypt и приватный ключ существуют,
   ключ принадлежит root.
2. Убедиться, что BillOK слушает исключительно 127.0.0.1:3000, что
   проверены тома 8.9 и переменные 8.11.
3. Сделать резервную копию BillOK vhost. Переключить только BillOK symlink
   с billok-acme.conf на billok-https.conf, не затрагивая других сайтов.
4. Выполнить nginx -t. При неуспехе — вернуть прежний BillOK symlink.
   Только после успешного теста выполнять systemctl reload nginx.
5. HTTPS должен иметь корректные SAN и цепочку для billok.ru. На HTTP
   (кроме ACME challenge) включено перенаправление на HTTPS. Значение
   X-Forwarded-For берётся только из remote_addr, а не из данных клиента.
   Для realtime запросов поддерживаются длительные соединения.
6. Подтвердить внешний HTTPS, health и порты:

       curl -fSI https://billok.ru/api/health
       curl -fSI --resolve billok.ru:443:89.169.2.31 https://billok.ru/api/health
       ss -ltn

   Порт 3000 может слушать только 127.0.0.1, не 0.0.0.0/89.169.2.31.
   Дополнительно проверить доступность с другого сетевого адреса,
   ротацию журналов Nginx и отсутствие секретов в ответах.

7. Проверить certbot.timer, выполнить certbot renew --dry-run. Для
   продления настроить отдельный deploy hook, проверяющий переменную
   RENEWED_DOMAINS на billok.ru и запускающий nginx -t и reload только
   при успешном обновлении этого сертификата. Не менять renewal других сайтов.

## Ограничения

- Никакой GitHub-hosted deployment, push-triggered релизов и обходов
  подтверждения владельца из 8.4.
- Не выпускать фиктивный сертификат и не открывать внутренний порт 3000.
- Не изменять пароли, AUTH_SECRET, SMTP в задаче 8.10: это 8.11.
- Не подменять обязательную предрелизную очистку из раздела 9.
- Приёмка 8.10 требует действительного Let's Encrypt, внешнего HTTPS и
  проверки loopback-only доступа. Пока владелец не разрешил публикацию,
  checkbox 8.10 остаётся открытым.
