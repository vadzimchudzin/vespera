"use strict";

// Russian wording of the Telegram bot. The bot composes its messages in English (one source, the tests read it);
// when the interface language of the executor is Russian, the text is put into Russian here just before it is
// queued. A message this module does not know is left in English rather than half-translated.

const STATUS = {
  stopped: "остановлена", paused: "на паузе", halt: "остановлена защитой", daily_limit: "дневной лимит потерь",
  running: "работает", watching: "ждёт сетап", warming_up: "загружает историю", order_sent: "ордер отправлен",
  waiting_settlement: "ждёт результат раунда", venue_down: "биржа недоступна", unknown: "неизвестно", changed: "изменилось",
};
const ORDER = { matched: "исполнен", live: "выставлен", delayed: "задержан", unmatched: "не исполнен", cancelled: "отменён",
  canceled: "отменён", rejected: "отклонён", "unknown status": "статус неизвестен", submitted: "отправлен", filled: "исполнен" };
const RESULT = { win: "плюс", loss: "минус", refund: "возврат", push: "возврат", unknown: "неизвестно" };
const PAUSE = [
  [/^final_settlement_pending(?::.*)?$/, "ждём окончательный результат раунда"],
  [/^venue_down(?::.*)?$/, "биржа недоступна"],
  [/^feed_source_not_binance_com(?::.*)?$/, "свечи идут не с Binance.com"],
  [/^risk halt$/, "остановка защитой"],
  [/^none$/, "нет"],
];

function status(word) { return STATUS[word] || word; }
function pause(reason) {
  for (const [pattern, text] of PAUSE) if (pattern.test(reason)) return text;
  return reason;
}
function mode(value) { return value === "paper" ? "Пейпер" : value === "auto" ? "Авто" : value; }

const EXACT = new Map(Object.entries({
  "Access is not approved. Request access to use the shared trading book.": "Доступ не подтверждён. Запросите доступ к общему счёту.",
  "Only the root administrator can manage access.": "Доступом управляет только главный администратор.",
  "Choose a control. Trading actions still follow execution ownership and risk checks.": "Выберите действие. Торговые команды проходят те же проверки исполнителя и рисков.",
  "Commands: /menu /status /balance /start /stop /new /mode paper|auto /strategy [id] /settings field=value": "Команды: /menu /status /balance /start /stop /new /mode paper|auto /strategy [id] /settings поле=значение",
  "Pairing is unavailable; ask the desktop app to create a new code.": "Привязка недоступна: создайте новый код в приложении.",
  "You are now the root administrator. Use the menu below to control the shared book.": "Вы — главный администратор. Управление — в меню ниже.",
  "Pairing code is invalid, expired, or already used.": "Код привязки неверный, просрочен или уже использован.",
  "No root administrator is paired yet. Use the one-time code from the desktop app with /pair CODE.": "Главный администратор ещё не привязан. Возьмите одноразовый код в приложении: /pair КОД.",
  "This account already has access or has a pending request.": "У этого аккаунта уже есть доступ или запрос ждёт решения.",
  "Access request sent to the root administrator.": "Запрос доступа отправлен главному администратору.",
  "No pending access requests.": "Запросов доступа нет.",
  "The root administrator cannot be revoked here.": "Главного администратора здесь отозвать нельзя.",
  "No pending request exists for that user.": "От этого пользователя запроса нет.",
  "Access is not approved. Use the access-request button in a private chat.": "Доступ не подтверждён. Нажмите кнопку запроса доступа в личном чате.",
  "Administrator tools": "Администрирование",
  "Confirmation could not be checked; request a new one.": "Подтверждение не удалось проверить: запросите новое.",
  "Confirmation expired, settings changed, access was revoked, or execution is no longer safe. Request a new confirmation.": "Подтверждение просрочено, настройки изменились, доступ отозван или запуск стал небезопасен. Запросите новое.",
  "Trading control is available only while the server or desktop is the active execution owner. Telegram never takes over a standby engine.": "Управление торговлей доступно, только пока исполнитель — сервер или приложение. Telegram не запускает резервный движок.",
  "Trading is already running.": "Торговля уже идёт.",
  "Start refused while a position or order is unresolved.": "Старт отклонён: есть незакрытая позиция или ордер.",
  "Start refused by the risk halt. Reconcile any unknown order or use New series only when the engine permits it.": "Старт отклонён защитой. Разберите ордер с неизвестным исходом или начните новую серию, когда это разрешено.",
  "Stop trading and finish or reconcile any open position/order before starting a new series.": "Остановите торговлю и закройте или разберите открытую позицию и ордер — потом новая серия.",
  "A new series resets the current loss progression; daily losses and unknown-order locks remain. Confirm within 60 seconds.": "Новая серия сбрасывает текущую прогрессию ставок; дневные потери и блокировки по неизвестным ордерам остаются. Подтвердите за 60 секунд.",
  "Usage: /mode paper|auto. Selecting Auto does not start trading.": "Формат: /mode paper|auto. Выбор «Авто» торговлю не запускает.",
  "Unknown strategy. Use /strategy to list available strategies.": "Такой стратегии нет. Список — /strategy.",
  "Use field=value for each setting.": "Каждая настройка — в виде поле=значение.",
  "Settings saved using the shared strict validator. Existing position/series locks still apply.": "Настройки сохранены. Блокировки по позиции и серии действуют.",
  "Trading start accepted. Check /status for the current state.": "Торговля запущена. Состояние — /status.",
  "New series refused: trading is active or a position/order is unresolved.": "Новая серия отклонена: торговля идёт или есть незакрытая позиция или ордер.",
  "New series confirmed. Daily loss totals and unknown-order protections were preserved.": "Новая серия начата. Дневные потери и защита по неизвестным ордерам сохранены.",
  "Desktop heartbeat restored. Server remains the execution owner.": "Приложение на ПК снова на связи. Торгует по-прежнему сервер.",
  "Desktop heartbeat lost. Server execution remains unchanged; Telegram will not take over the desktop.": "Приложение на ПК отключилось. На сервер это не влияет: он работает как работал. Управление — здесь, в Telegram.",
  "Vespera Telegram test message: delivery is working.": "Vespera: проверка Telegram — сообщения доходят.",
  // buttons
  "Request access": "Запросить доступ", "Approve": "Разрешить", "Deny": "Отказать", "Requests": "Запросы",
  "Approved users": "Пользователи", "Status": "Статус", "Confirm LIVE start": "Подтвердить старт на реальные деньги",
  "Confirm new series": "Подтвердить новую серию", "Paper": "Пейпер", "Auto": "Авто",
}));

const PATTERNS = [
  [/^Execution status: (\w+)(?: · (.+))?$/, (m) => `Торговля: ${status(m[1])}${m[2] ? ` · ${pause(m[2])}` : ""}`],
  [/^Opening signal: (\S+) · \$(\S+)( · Paper)?$/, (m) => `Сигнал на вход: ${m[1]} · $${m[2]}${m[3] ? " · Пейпер" : ""}`],
  [/^Order update: (\S+) · \$(\S+) · ([^@·]+?)( @ \S+)?( · fee \$\S+)?$/, (m) =>
    `Ордер: ${m[1]} · $${m[2]} · ${ORDER[m[3].trim()] || m[3].trim()}${m[4] ? ` по ${m[4].slice(3)}` : ""}${m[5] ? ` · комиссия ${m[5].slice(7)}` : ""}`],
  [/^Settlement: (\S+) · (\S+) · net P&L \$(\S+) · fee \$(\S+)$/, (m) =>
    `Расчёт: ${m[1]} · ${RESULT[m[2]] || m[2]} · итог $${m[3]} · комиссия $${m[4]}`],
  [/^Setup: (.*?)( · v\S+)?( · modified)? · (\S*)$/, (m) => `Сетап: ${m[1]}${m[2] || ""}${m[3] ? " · изменён" : ""} · ${m[4]}`],
  [/^Risk halt: (.+)\. Review the desktop\/server state; Telegram cannot clear safety locks\.$/, (m) =>
    `Остановка защитой: ${m[1] === "execution halted" ? "торговля остановлена" : m[1]}. Проверьте состояние в приложении: из Telegram защиту не снять.`],
  [/^Execution: (desktop|server) · (\S+) · (running|stopped)$/, (m) =>
    `Исполнитель: ${m[1] === "server" ? "сервер" : "приложение на ПК"} · ${status(m[2])} · ${m[3] === "running" ? "торговля идёт" : "торговля остановлена"}`],
  [/^Mode: (\S+)( \(dry run\))?$/, (m) => `Режим: ${mode(m[1])}${m[2] ? " (пробный прогон)" : ""}`],
  [/^Strategy: (.+)$/, (m) => `Стратегия: ${m[1] === "unknown" ? "неизвестно" : m[1]}`],
  [/^Available: (.*)$/, (m) => `Доступны: ${m[1]}`],
  [/^Balance: \$(\S+) · (wallet|paper)( · last known)?$/, (m) =>
    `Баланс: $${m[1]} · ${m[2] === "wallet" ? "кошелёк Polymarket" : "виртуальный (Пейпер)"}${m[3] ? " · последнее известное" : ""}`],
  [/^Balance: checking$/, () => "Баланс: проверяю…"],
  [/^Balance: unavailable(?: \((.+)\))?$/, (m) => `Баланс: недоступен${m[1] ? ` (${m[1]})` : ""}`],
  [/^Dry-run account: \$(\S+)$/, (m) => `Пробный счёт (виртуальный): $${m[1]}`],
  [/^Series: step (\S+)\/(\S+) · loss \$(\S+)$/, (m) => `Серия: шаг ${m[1]} из ${m[2]} · убыток $${m[3]}`],
  [/^Position: (.+)$/, (m) => `Позиция: ${m[1] === "none" ? "нет" : m[1]}`],
  [/^Pause: (.+)$/, (m) => `Пауза: ${pause(m[1])}`],
  [/^Stopped\. Current status: (\w+)\.$/, (m) => `Остановлено. Состояние: ${status(m[1])}.`],
  [/^Real-money start requested for (.+) · base stake \$(\S+) · max stake \$(\S+)\. Confirm within 60 seconds\.$/, (m) =>
    `Старт на реальные деньги: ${m[1] === "current strategy" ? "текущая стратегия" : m[1]} · базовая ставка $${m[2]} · предел ставки ${m[3] === "unlimited" ? "не задан" : `$${m[3]}`}. Подтвердите за 60 секунд.`],
  [/^Start refused: (.+)\.$/, (m) => `Старт отклонён: ${pause(m[1])}.`],
  [/^Action refused: (.+)\.$/, (m) => `Действие отклонено: ${m[1]}.`],
  [/^Mode selected: (\S+)\. Trading was not started\.$/, (m) => `Режим: ${mode(m[1])}. Торговля не запускалась.`],
  [/^Mode unchanged: (.+)\.$/, (m) => `Режим не изменён: ${m[1]}.`],
  [/^Strategy selected: (.+)\.$/, (m) => `Стратегия выбрана: ${m[1]}.`],
  [/^Strategy unchanged: (.+)\.$/, (m) => `Стратегия не изменена: ${m[1]}.`],
  [/^Editable: (.+)\. Format: \/settings field=value$/, (m) => `Можно менять: ${m[1]}. Формат: /settings поле=значение`],
  [/^Setting is not remotely editable: (.+)\.$/, (m) => `Эту настройку отсюда менять нельзя: ${m[1]}.`],
  [/^Settings unchanged: (.+)\.$/, (m) => `Настройки не изменены: ${m[1]}.`],
  [/^Access requested by Telegram user (\d+)\.$/, (m) => `Пользователь Telegram ${m[1]} просит доступ.`],
  [/^Pending requests: (.+)$/, (m) => `Запросы доступа: ${m[1]}`],
  [/^Root administrator: (.+)$/, (m) => `Главный администратор: ${m[1] === "none" ? "нет" : m[1]}`],
  [/^Approved users: (.+)$/, (m) => `Пользователи: ${m[1] === "none" ? "нет" : m[1]}`],
  [/^Usage: (\/\w+) TELEGRAM_USER_ID$/, (m) => `Формат: ${m[1]} НОМЕР_ПОЛЬЗОВАТЕЛЯ`],
  [/^Access revoked for (\d+)\.$/, (m) => `Доступ отозван: ${m[1]}.`],
  [/^Approved (\d+)\.$/, (m) => `Доступ разрешён: ${m[1]}.`],
  [/^Denied (\d+)\.$/, (m) => `В доступе отказано: ${m[1]}.`],
  [/^Revoke (\d+)$/, (m) => `Отозвать ${m[1]}`],
];

function line(text) {
  const exact = EXACT.get(text);
  if (exact) return exact;
  for (const [pattern, render] of PATTERNS) {
    const match = pattern.exec(text);
    if (match) return render(match);
  }
  return text;
}

// A message: whole first (some sentences hold a line break of their own), then line by line.
function toRussian(text) {
  const value = String(text ?? "");
  return EXACT.get(value) || value.split("\n").map(line).join("\n");
}

function keyboardToRussian(keyboard) {
  if (!Array.isArray(keyboard)) return keyboard;
  return keyboard.map((row) => Array.isArray(row) ? row.map((key) => key && typeof key.text === "string" ? { ...key, text: line(key.text) } : key) : row);
}

module.exports = { toRussian, keyboardToRussian };
