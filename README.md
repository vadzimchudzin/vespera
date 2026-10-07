# Vespera (VSP)

Glass desktop terminal for BTC 15m Polymarket Up/Down.

**v0.24.0.** SMA/EMA 200/20 on a **closed** candle `S`, bet on **S+1**. Arrow sits on the entry candle. Auto prices the live Polymarket round and sends **CLOB V2** signed orders once the wallet, a signing key and the derived CLOB keys are in the API panel.

**Для следующих агентов:** [подробный отчёт и передача проекта](#отчёт-и-передача-проекта--2026-10-06) · [ROADMAP](ROADMAP.md) · [правила Zero Mode](docs/ZERO_MODE.md). Публикация релиза не означает слияние PR в `main`; перед продолжением сверяйте GitHub.

**Payout is not ×2.** Polymarket pays $1 per winning share, so the multiple is `1 / price`. At an ask of 0.72 a $1 stake returns $1.39 while a loss still costs the full $1 — Paper books results on that same number. Crypto rounds also charge a taker fee of `0.07 × p × (1 − p)` per share (≈3.5% of the stake at 0.50), paid in USDC on top of the stake and lost on either outcome. Paper and live P&L both deduct it; Paper without a live quote assumes a price of 0.50. A flat ×2 martingale does **not** recover a loss at those odds; size the series accordingly.

**Resolution.** Paper and dry run settle on Binance. Real-money positions now wait
for the final Polymarket result: Binance is only a provisional checkpoint, not a
series win/loss. This conservative implementation stops entries until finality;
after the final result, inspect the series and press Start to resume. It may skip
rounds while waiting. See [financial reconciliation](docs/RECONCILIATION.md).

**Operations and secrets.** [Server operations](docs/OPERATIONS.md) provides
preflight, offline backup, fenced isolated restore, monitor units and a TLS example.
[Secret storage](docs/SECRETS.md) uses a secure OS backend or a random private
master key, with fail-closed migration and rotation. Production deployment,
external alerts and a 24–72-hour soak still require the real server.

Repo: private [`VadimChudin/vespera`](https://github.com/VadimChudin/vespera)

## What it does

**Research lab.** Backtest an exact saved setup and compare up to ten independent
forward Paper books, sharing feeds by market/timeframe. Balance, series and results
are separate from account trades. Stored datasets/fingerprints identify the replay;
the current Binance/0.50 model is explicitly approximate, not historical Polymarket
returns. Reports expose fees, drawdown and sample size alongside P&L.
See [Research](docs/RESEARCH.md).

**Saved setups.** Settings → Strategy saves named immutable versions, copies and
imports/exports definitions without secrets. Trades keep their original setup
version and configuration fingerprint; manual edits are marked modified rather
than silently attributed to an unchanged saved version. Applying a version is a
stopped, position-free operation and never starts trading or changes dry run.
See [setups and timeframe rules](docs/SETUPS.md).

- Slow MA (trend) + fast MA (trigger) on **closed** Binance candles, **SMA or EMA** (Settings → Average). Default `BTCUSDT` 15m; pick any listed pair / timeframe.
- Above 200 → only UP. Below 200 → only DOWN.
- Entry: the pullback bar’s **body** lies beyond the fast average on the opposite side (wicks ignored). Then `confirmCount + 1` consecutive qualifying candles of the required colour. Qualification follows Full body on S: full body beyond the average when enabled, or a touching candle closing through it when disabled. Periods and SMA/EMA are configurable.
- Bet is on **the next** candle (`S+1`). Forming candle never signals.
- Series, default 6 steps (1–20 in Settings). **×2** doubles the stake; **Fixed** follows an explicit dollar ladder independent of entry price; **Recover** targets prior losses plus the base profit and can grow quickly. Neither ×2 nor Fixed guarantees recovery. Max stake, series-loss budget (including fees), daily loss limit and max entry price are available. Win resets the series. Losing every step → halt; explicitly confirm a new series before Start.
- **Statistics** shows win rate against the break-even rate at the prices you actually got, fees, drawdown, how deep series went and results by day. **Export trades to CSV** writes every settled bet.
- Chart is always live (Binance WebSocket + REST fallback). SMA lines use **closed** candles only.
- Trade arrows appear only while Paper/Auto is **started**. Idle = clean chart.
- Settings **Chart refresh**: 1–2000 ms, applied live. **Min opening**: minimum fast/slow average distance divided by ATR(14). **Min cross**: close must be X **exchange ticks** beyond the fast average (`0` = no extra distance).
- Header: instrument + timeframe as iOS pills. Status lamp instead of “Waiting for signal”. Blue **Last candle** stays on the chart.

## Modes

**Settings are grouped by task:** Strategy, Stakes & risk, Execution, Polymarket,
Telegram and Interface. Switching sections preserves the form controls and drafts.
Trading locks and the common validator still apply; organizing the UI does not
reset a series or enable real-money trading.

**Telegram control and access:** configure the bot in Settings → Telegram and
pair the root administrator with a single-use code. Other private-chat users request
access; only the root administrator may approve, deny or revoke it. Telegram shares
the existing engine and risk rules. See [Telegram onboarding and limitations](docs/TELEGRAM.md).

| Mode | Name in UI | Orders |
|---|---|---|
| Paper | Paper / Пейпер | Virtual Up/Down fills |
| Auto | Auto / Авто | Prices the live round on `clob.polymarket.com`, signs CLOB V2 EIP-712 orders and posts them as FAK (fill-and-kill) with 2 cents of price room. Needs wallet, private key and the derived CLOB keys. Verified mappings: **BTC, ETH, SOL, XRP, DOGE, BNB, HYPE** on **5m/15m**, and **BTC, ETH, SOL, XRP** on **1h/4h**. Longer rounds must match the exact UTC interval, tokens and resolution rules; no missing round falls back to 15m. Paper keeps Binance chart intervals. Minimum order is 5 shares; the wallet must hold stake + taker fee. |

**Connect** in the API panel checks the account; it does not place trades.

**Safeguards.** Auto starts in **dry run**: everything but posting the order (price, stake, fee, balance check, real signature), booked apart from real money. Turning it off makes Start ask for confirmation with the stakes and total at risk. An optional daily loss limit stops trading until midnight. A watchdog pauses Auto when Polymarket is unreachable or an order error would repeat (no balance, lot under the minimum, repeated rejections).

**Connection recovery.** Temporary venue outages keep health checks running and resume the previously started session once reachability and the trading-region check recover. Manual Stop, risk limits and unknown order outcomes never auto-resume. Critical trade state is checkpointed separately from rotating logs. See [stability and recovery](docs/STABILITY.md) for diagnostics and unresolved-order handling.

**Zero Mode.** Settings → Execution connects to a separately installed authenticated server. Turning Zero Mode on transfers a stopped, position-free book to that server; the desktop becomes a UI client. Closing or restarting the desktop never stops or duplicates server execution. Turning it off requires the server to confirm release. Lost handoff responses stay locked and can be retried with the same durable request. The server uses direct venue connections and ignores trading-proxy settings; the desktop keeps its own optional proxy. Server deployment/TLS and the server's Telegram token must be configured separately. See [Zero Mode](docs/ZERO_MODE.md) and [deployment](deploy/README.md).

**Settings and risk.** The window, engine and persistence check settings against the same rules. Fixed mode derives its base and step count from the ladder. Trading settings are locked during an active position or order; stake sizing is also locked during a losing series. Save no longer silently resets a halted series. Use the explicit New series action while stopped and without a position; it does not erase daily P&L. See [settings and stake limits](docs/SETTINGS.md).

**Wallet type.** Auto-detect compares the wallet with the signing key: same address → EOA, the key's legacy proxy → Proxy, its legacy Safe → Safe, anything else → **Deposit Wallet** (every account created since May 2026). Override it in the API panel if detection is wrong. Collateral is **pUSD**; polymarket.com wraps USDC into it automatically.

## Keys

1. Polymarket → **Account → Private key → Start export**. That key only signs; it is stored encrypted on this machine and never leaves it.
2. Copy your Polymarket wallet address from the profile menu.
3. In Vespera → **API**, paste both and press **Connect**. The CLOB L2 credentials (`apiKey`, `secret`, `passphrase`) are derived from a `ClobAuth` signature — there is no page on polymarket.com that shows them. "Relayer API keys" in Settings is a different thing and is not used here.
4. Connect shows a checklist: reachability / region, key, wallet, wallet type, CLOB keys, current round and price, pUSD balance against the first bet and a full series, and the exchange allowance. Green means ready for live orders.

Manual CLOB keys and the proxy are under **Advanced** in the same panel.

**Test bet.** Under Connect, *Test bet UP / DOWN* places one minimum order (5 shares, about $3) on the current round right away, after a confirmation, so the live path can be checked without waiting for a signal. It does not touch the series or statistics; in dry run it is signed but not sent.

## Funding the wallet

Polymarket trades in **pUSD on Polygon**, but it accepts deposits from other networks through its bridge. Menu → **Deposit**: pick the coin and the network (for example **USDT · Tron**), send it to the address shown, and the bridge credits pUSD to your Polymarket wallet, usually within minutes. Each network has a minimum (about $2–4); send only the selected coin on the selected network. The address is tied to the wallet address in the API panel, so fill that in first.

## Blocked regions

Polymarket geoblocks a list of jurisdictions (Belarus among them) and refuses both the site and the API from those IPs. Prices, balances and key derivation still work from a blocked IP; only orders are refused (`403 Trading restricted in your region`). **Connect** therefore asks Polymarket's geoblock endpoint and shows a red *Trading region* row with the country, and real-money **Start** is refused while the region is blocked. A proxy URL in the API panel (`http://user:pass@host:port`, `socks5://host:port` or plain `host:port`) routes every CLOB, Gamma, bridge and geoblock call through an allowed jurisdiction. If the proxy cannot be used, calls fail with `proxy_unavailable` instead of silently going direct. SOCKS proxies get the host name and resolve it themselves (`socks5://` is treated as `socks5h://`); if the proxy refuses that, Vespera retries once over local IPv4 and remembers the route that works. Connect names the exact proxy fault (login, port, proxy cannot reach Polymarket) and real-money Start is refused while the proxy is broken.

## Run from source

```bash
npm install
npm test
npm start
```

## Cut a version (Win + Mac)

Bump `version` in `package.json`, add a `CHANGELOG` line, tag:

```bash
git tag v0.17.0
git push origin v0.17.0
```

GitHub Actions builds:

- Windows: `Vespera-<ver>-win-x64.exe` (NSIS, desktop + Start Menu shortcuts)
- macOS: `Vespera-<ver>-mac.dmg`

**First launch on a Mac.** The app is ad-hoc signed but not notarized by Apple (that needs a paid Developer ID). Drag Vespera to *Applications*, open it once, press *Done*, then **System Settings → Privacy & Security → “Vespera” was blocked → Open Anyway**. On macOS 15+ right-click → Open no longer offers this. If a copy arrived through a messenger and still refuses, run in Terminal:

```bash
xattr -cr /Applications/Vespera.app
```

Universal build: runs natively on Apple Silicon and Intel Macs.

Local:

```bash
npm run dist:win
npm run dist:mac
```

## Layout

```
src/main/        engine, strategy, paper broker, journal, live market
src/renderer/    glass UI, i18n EN/RU, TradingView host
build/           app icon (.png / .ico)
```

`Strategy` does not know Polymarket. `Broker` does not know MAs. Live venues implement `src/main/brokers/spi.js` (`ping`, `getBalance`, `marketBuy`). Auto uses `PolymarketAdapter` + Gamma slug `btc-updown-15m-{utcStart}`.

## Spec

See `docs/TZ_Predic_MA200_MA20.md`.

---

## Отчёт и передача проекта — 2026-10-06

**Дополнение 0.23.0 source, 2026-10-07:** именованные версии сетапов,
копирование/import/export без секретов, атрибуция сделок/CSV/Telegram,
перенос библиотеки в Zero Mode. Подтверждены публичные рынки BTC/ETH/SOL/XRP
1h и 4h; код проверяет отдельные правила ET/UTC и источник расчёта.
Сигнальный TF и экспирация пока должны совпадать. Правила — [SETUPS](docs/SETUPS.md).

**Дополнение 0.22.0 source:** подготовлен эксплуатационный набор для этапа 5;
добавлены сверка fills, операторский экран, ожидание окончательного результата
и fail-closed хранение ключей для первого объёма этапа 6. Ниже сохранён
исторический отчёт 0.20.0: его ограничения и статусы не являются текущими.
Фактические правила обновления — [OPERATIONS](docs/OPERATIONS.md),
[RECONCILIATION](docs/RECONCILIATION.md), [SECRETS](docs/SECRETS.md).

**Дополнение 0.21.0:** Telegram-пульт с запросами доступа и админкой,
а также группировка настроек добавлены после приведённого ниже отчёта о 0.20.0.
Правила подключения и ограничения — [TELEGRAM](docs/TELEGRAM.md).
Исторические статусы PR и результаты проверок ниже относятся к моменту
передачи 0.20.0, а не являются текущим подтверждением CI или live-работы.

### 1. Краткий итог и статус публикации

Проект развивался от десктоп-терминала до системы с отдельным серверным ядром и
ПК-клиентом. Выполнены три инженерных этапа: восстановление и безопасность
исполнения, предсказуемые ставки/настройки, серверное исполнение/Zero Mode.

| Этап | Релиз | PR | Статус на момент отчёта |
| --- | --- | --- | --- |
| Стабильность | [0.18.10](https://github.com/VadimChudin/vespera/releases/tag/v0.18.10) | [#17](https://github.com/VadimChudin/vespera/pull/17) | Опубликован; PR открыт |
| Настройки и ставки | [0.19.0](https://github.com/VadimChudin/vespera/releases/tag/v0.19.0) | [#18](https://github.com/VadimChudin/vespera/pull/18) | Опубликован; PR открыт |
| Сервер/Zero Mode | [0.20.0](https://github.com/VadimChudin/vespera/releases/tag/v0.20.0) | [#19](https://github.com/VadimChudin/vespera/pull/19) | Опубликован; PR открыт, CI зелёный |

Точка программной передачи: тег `v0.20.0`, коммит `2a009ee`.
Ветка реализации: `hoplite/axos-4ebe8446--settings--zero`.
`main` на момент отчёта всё ещё содержит `0.18.1` (`df356b7`). Не начинать
продолжение с предположения, что все новые возможности уже находятся в `main`.
PR #19 основан на #18, #18 — на #17, #17 — на #16; ниже остаются ранее открытые
ветки сборки. Перед слиянием сверить весь стек, включая #13/#14/#16 и отдельный
#15; не сливать автоматически и не делать force-push по предположению.
Черновик `0.18.9` не рекомендован: первый Windows-прогон обнаружил ошибку
платформенной проверки прав; исправление вошло в `0.18.10`.

**Не выполнено:** развёртывание на сервере клиента, HTTPS/DNS, Telegram,
бэктест, сохранённые конкурирующие сетапы, локальный/облачный ИИ. Серверные
исходники готовы, но продакшен-доступ не предоставлялся. Реальных денежных
ордеров во время работы агента не отправляли; годовая стабильность и
прибыльность не доказаны.

### 2. Согласованный продуктовый контракт

- Сервер — основной исполнитель; ПК — интерфейс и резервный локальный режим.
- В рамках одной зарегистрированной пары ПК/сервер торгует только один
  назначенный исполнитель. Это не глобальная защита от других ботов того же кошелька.
- Закрытие ПК в Zero Mode не останавливает сервер. В локальном режиме
  выключенный ПК перестаёт исполнять алгоритм; сервер не подхватывает его автоматически.
- Пропавшая связь означает неизвестный текущий статус сервера, а не его остановку.
  Нельзя автоматически включать локальный дубль.
- Передача выполняется с подтверждением и без открытых позиций/неизвестных
  ордеров; переключение само не нажимает Start. В дальнейшем можно обсуждать
  изменение этого UX, но не убирать проверку единственного исполнителя.
- Telegram предназначен только клиенту как упрощённый пульт. Согласованы
  отчёты после каждой сделки даже при открытом ПК; реализация ещё впереди.
- Пользователь просит агента самому проверять результаты и присылать свежие
  скриншоты, а не перекладывать каждый цикл проверки на клиента.

### 3. Этап 1: что изменено

**Котировки:** таймаут WebSocket-рукопожатия, реконнект, защита от запоздалых REST
ответов после Stop/смены рынка, ограничение истории до 2 000 свечей. Сделки
обновляют формирующуюся свечу, но не объявляют её закрытой. Гапы в необходимом
окне индикаторов и просроченные восстановленные сигналы препятствуют входу.

**Исполнение:** закрытия свечей обрабатываются последовательно; параллельные
сигнальные/тестовые входы блокируются. Stop и существенные изменения настроек
отменяют подготовку ещё не отправленного ордера, в том числе перед POST в адаптере.
Уже принятый площадкой ордер нельзя считать отменённым нажатием Stop.

**Устойчивое состояние:** баланс, позиция и серия восстанавливаются из отдельного
атомарного checkpoint, а не только из хвоста вращающегося журнала. Сохранённые
последовательности устраняют неоднозначность равных timestamp. Перед live POST
пишется pending intent; неизвестный ответ блокирует новые ордера и после рестарта.
Поздний расчёт использует свечу исходного раунда, не произвольную последнюю свечу.

**Восстановление:** временная недоступность площадки сохраняет health checks и
может возобновить ранее запущенную сессию. Ручной Stop, риск-паузы и неизвестный
ордер автоматически не сбрасываются. Принятая тестовая ставка блокирует повторные
входы до завершения её раунда, отдельно от результатов стратегии.

### 4. Этап 2: ставки и настройки

Три разных режима: **×2**, **фиксированная лестница**, **динамический Отыгрыш**.
В лестнице до 20 явных USD-сумм; первая задаёт базу, длина — число шагов.
Например, `5, 10, 20, 40` не превращается в другую лестницу из-за цены 0.70.
Потолок ставки может уменьшить фактическую сумму. Фиксированная серия и ×2 не
гарантируют возврат потерь: выплата исхода зависит от цены и комиссий.
`1 / price` — коэффициент валовой выплаты на доллар ставки при выигрыше,
не чистая прибыль; комиссия и возвращённая ставка учитываются отдельно.

Отыгрыш сохранён как отдельный режим: `base + seriesLoss / netWinPerDollar`.
При дорогом исходе сумма быстро растёт; жалоба клиента на $40 на третьем шаге
не была доказательством арифметической ошибки без журнала. Решение — явный
фиксированный режим и ограничения, а не ложное обещание отыгрыша.

Добавлены бюджет серии с комиссиями и проверка оставшегося дневного лимита до
входа; свежий расчёт live-адаптера проверяется ещё раз до отправки. Тестовые
ставки также учитывают ограничения. План — расчёт при последней известной цене
либо явное допущение 0.50, не гарантированный будущий результат.

`src/shared/settings.js` задаёт одинаковые правила для окна, ядра и диска:
невалидный/заблокированный патч отвергается целиком. Быстрые изменения ползунков
объединяются, записи сериализуются, ошибка не закрывает форму и не уничтожает черновик.
Сохранение не сбрасывает серию. «Новая серия» — отдельное подтверждённое действие
при остановке и отсутствии позиции; дневные убытки остаются.

| Настройка | Границы / смысл |
| --- | --- |
| База | $0.01–1 000 000; в Fixed — первая сумма лестницы |
| Шаги | 1–20; в Fixed — длина лестницы |
| Макс. цена входа | 0.05–1.00; 1 выключает фильтр |
| Мин. раскрытие | `abs(fast − slow) / ATR(14)`, 0–2, шаг 0.05 |
| Мин. кросс | расстояние закрытия за fast в биржевых тиках, 0–2 000 |
| Подтверждения | 0–10 дополнительных квалифицирующих свечей |
| Быстрая / медленная | 2–200 / 5–500; slow всегда больше fast |
| Обновление графика | 1–2 000 мс; не частота оценки сигналов |
| Лимиты суммы | 0 выключает; бюджет серии учитывает комиссии |

Критерий подтверждающей свечи зависит от «Полное тело на S». Текущие периоды
и SMA/EMA применяются к стратегии и линиям графика; старые подписи SMA20/200
в подсказках были заменены описаниями быстрой/медленной средней.

### 5. Этап 3: архитектура и Zero Mode

| Файл / группа | Ответственность |
| --- | --- |
| `src/main/engine.js`, `strategy.js`, `risk.js` | Сигнал, позиция, серия, ограничения |
| `src/main/marketData.js` | Binance WS/REST и непрерывность свечей |
| `src/main/journal.js`, `settingsStore.js` | Журнал, checkpoint, локальные секреты |
| `src/shared/settings.js` | Общая нормализация настроек |
| `src/main/executionHost.js` | Ядро без Electron, команды, импорт/экспорт книги |
| `src/main/executionRouter.js`, `remoteClient.js` | Выбор исполнителя, HTTP, переходы |
| `src/main/main.js`, `preload.js` | Desktop IPC и безопасный мост к renderer |
| `src/server/service.js`, `start.js` | Auth, владелец, сериализация, API, запуск |
| `src/renderer/app.js`, `chart.js`, `i18n.js` | Интерфейс, график, EN/RU |
| `deploy/` | Инструкции и systemd; не выполненный продакшен-деплой |

К серверу маршрутизируются команды торговли, настройки, account/API,
пополнение и CSV. Пакет передачи содержит настройки/ключи, checkpoint и последние
5 000 строк журнала; старые архивы остаются на исходной машине. Лимит пакета —
16 MiB. Пакеты повтора шифруются, новые книги сохраняются отдельными epoch-папками.

Владелец, request tombstones и точный пакет повтора записываются устойчиво.
Потеря ответа не включает второй движок. Повтор активации проверяет тот же
fingerprint; тесты моделируют сбой до указателя книги и до фиксации владельца.
Обычный неоднозначный торговый POST автоматически не повторяется.

Сервер принимает bearer token и привязан к одному device ID. По умолчанию
слушает loopback; для внешнего ПК нужен HTTPS с валидным сертификатом.
Trading proxy на сервере принудительно пустой, включая Bridge; локальный ПК
сохраняет свой proxy как машинную настройку. TLS reverse proxy control API
не является обходом торговых/региональных ограничений.

ПК опрашивает состояние и показывает офлайн/устаревшие данные; heartbeat исчезает через
30 секунд без изменения владельца. Сервер может восстановить ранее явно
запущенную server-owned сессию после рестарта, но не должен отменять Stop,
неизвестный ордер или риск-паузу. При local owner сервер остаётся неторговым.
Токен того же endpoint можно обновить после проверки владельца, не меняя режим.

### 6. Что подтверждено и насколько уверенно

**Высокая уверенность в пределах тестовых сценариев:** фиксированные суммы,
валидация/атомарный отказ настроек, объединение патчей, сохранение checkpoint,
блокировка неизвестного ордера, сериализация, позиционно-безопасная передача,
точный повтор после сбоя и отсутствие автоматического локального fallback.
Это подтверждено автоматическими проверками, не общей гарантией отсутствия ошибок.

**Реальный интерфейс:** Electron 0.19.0/0.20.0 запускался с временным Paper-профилем
без клиентских ключей. Проверены лестница, бюджет, неверный ввод, русские подписи,
подключение, подтверждение Zero Mode, server Paper Start, возврат на ПК,
SIGSTOP/SIGCONT службы и блокировка команд при потере связи. Скриншоты опубликованы в PR.
Свежая CDP-сессия после исправления пересинхронизации не зарегистрировала ошибок renderer.

**CI/сборки:** `npm test` содержит 20 тестовых файлов, серверный файл — 19
отдельных сценариев. CI прошёл на Node 22 в Linux, Windows, macOS. Windows x64
EXE и macOS Universal DMG опубликованы; подпись ad-hoc и обе macOS-архитектуры
проверялись в сборке. Это не тест установки на всех пользовательских машинах.

В процессе проверки исправлялись реальные находки: Windows-права/fsync,
неверный bind-host при запуске службы, расхождение RPC-ответов, зависание после
известного отказа release, потеря подписок при закрытии macOS-окна, старые
производные поля лестницы, ошибка старой свечи графика и crash-window активации.

**Не подтверждено:** реальные live fill/partial fill на счёте клиента,
продакшен-сеть/TLS/systemd, безопасная миграция реальных ключей клиента,
многодневный memory/rate-limit soak, год работы, прибыльность стратегии,
автоматическая сверка с окончательным расчётом площадки, Telegram и AI.

### 7. Что перепроверить и что заменить

1. **Сверка исполнений — P0 перед автономными деньгами.** Unknown intent сейчас
   блокируется, а не автоматически разрешается. Нужны авторитетные order/fill
   проверки и журналируемый операторский сценарий, без кнопки «просто очистить».
2. **Расчёт раунда — P0.** `_settleLive` ведёт серию по Binance; площадка решает
   по Chainlink. `_reconcileLive` сообщает mismatch, но не пересчитывает серию
   автоматически. Перейти к предварительному/окончательному результату и
   детерминированной коррекции; сначала определить политику следующих входов.
3. **Защита ключей — P0/P1.** `safeStorage` используется где доступен; headless
   fallback AES-ключ выводится из hostname/user/path, это не секретный master key.
   `encryptSecret` при крайней ошибке может вернуть plaintext. Пересмотреть на
   fail-closed хранение и отдельный защищённый master key/OS secret store.
   Нельзя писать, что текущая схема защищает от владельца файловой системы.
4. **Деньги — P1.** `money.js` — небольшой cent-wrapper над JS Number, не
   полноценная decimal-библиотека. Risk/fees/shares также используют Number.
   Проверить микроединицы, округления/границы/большие суммы, затем выбрать
   integer micro-units либо подходящую decimal-арифметику без смены экономики.
5. **24/7 — P1.** Проверить память, REST-нагрузку, stale snapshots, sleep/restart,
   длительные запросы, NTP, disk-full, восстановление открытого раунда и лимитов.
   systemd `Restart` не заменяет внешний мониторинг и сигнализацию.
6. **Хранилище — P1.** Epoch-копии и request tombstones сохраняются; это надёжный
   протокол, но потребуется политика retention/резервирования и disk alerts.
   Не удалять tombstones или owner-файлы без сохранения защиты от replay.
7. **Транспорт — P2.** Snapshot polling достаточен для первого клиента; проверить
   объём истории/CPU. При доказанной нагрузке заменить на delta/SSE/WS с версией,
   reconnect и сохранением защит, а не ради самого рефакторинга.
8. **Граница доверия — P1.** Проверить HTTPS, токен-rotation, allowlist,
   отзыв доступа и аудит перед внешним размещением. Протокол одного device не
   защищает от копий userData/вторых независимых ботов. Для мульти-клиента нужен
   новый fencing/identity design, не ослабление текущего owner check.

Эти пункты — подтверждённые ограничения либо план дальнейшего аудита, а не
утверждение, что каждый возможный отказ уже воспроизведён. Не менять безопасный
fail-closed на удобный повтор или перехват исполнения без связи с сервером.

### 8. Продолжение следующими агентами

1. Сверить `git status`, релизы, PR и актуальную базу; прочитать этот раздел,
   [ROADMAP](ROADMAP.md), [STABILITY](docs/STABILITY.md),
   [SETTINGS](docs/SETTINGS.md), [ZERO_MODE](docs/ZERO_MODE.md),
   [deploy](deploy/README.md). Старое ТЗ Predic — история, не текущий API-контракт.
2. Не коммитить ключи, токены, настройки клиента, `.hoplite/runtime`, временные
   профили, private bundles, дампы журналов или непроверенные скриншоты.
3. Выполнить `npm ci`, `npm test`; для UI запустить managed desktop preview.
   `.hoplite/preview.sh` создаёт временный Paper server/desktop. HTTP 3000 —
   статусная страница, не веб-терминал; реальный UI проверяется через CDP 9222.
   Отладочный порт/`--no-sandbox` относятся к sandbox-проверке, не продакшену.
4. Для Telegram использовать одно серверное ядро/очередь команд. Не создавать
   второго Engine внутри бота, не переиспользовать desktop device ID произвольно.
5. Проверять самостоятельные изменения тестами, актуальным UI и diff; присылать
   пользователю screenshots и фактический статус. Не обещать live-проверку,
   если запускался только Paper/mock.
6. Документировать rollout/backup/rollback, зависимости стека PR и ограничения.
   После push проверить CI/review; релиз считать готовым после обеих сборок.
   Документационное обновление не требует новой версии бинарника.

Следующая функциональная работа — Telegram-пульт/отчёты; продакшен-деплой и
P0-аудит финансового состояния выполнять до допуска автономной торговли
деньгами. Полная очерёдность и критерии готовности — [ROADMAP](ROADMAP.md).
