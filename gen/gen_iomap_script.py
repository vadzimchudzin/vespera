#!/usr/bin/env python3
"""Генерирует machine_expert/map_io.py - скрипт Machine Expert (Инструменты -> Скрипты ->
Выполнить файл сценария), который привязывает каналы DI/DQ и модулей TM3 к переменным GVL_IO
по doc/IO_map.csv."""
import csv
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

rows = []
with open(os.path.join(ROOT, 'doc', 'IO_map.csv'), encoding='utf-8-sig') as f:
    for r in csv.DictReader(f, delimiter=';'):
        m = re.match(r'^([IQ])(\d+)$', r['Канал'])
        rows.append((r['Модуль'], m.group(1), int(m.group(2)), r['Переменная GVL_IO']))

table = ',\n'.join(f"    (u{mod!r}, u{kind!r}, {ch}, u{var!r})" for mod, kind, ch, var in rows)

SCRIPT = r'''# -*- coding: utf-8 -*-
# ЕФБШ-649.01-АТХ: привязка каналов ввода-вывода к переменным GVL_IO.
# Сгенерировано gen/gen_iomap_script.py из doc/IO_map.csv.
#
# Запуск: Machine Expert -> Инструменты -> Скрипты -> Выполнить файл сценария -> map_io.py
# (проект с контроллером и модулями открыт, PLCopenXML уже импортирован).
# Первый запуск с APPLY = False только печатает план в окно сообщений. Если план верный -
# поставить APPLY = True, запустить ещё раз, сохранить проект.
from __future__ import print_function

APPLY = False
APP = u"Application"          # имя приложения в дереве устройств

# (модуль по Э3, I/Q, номер канала, переменная)
MAP = [
%(table)s
]

# A1 - встроенные DI/DQ контроллера, A1.1..A1.9 - модули под IO_Bus по порядку подключения
EXPECT = {u"A1:I": 24, u"A1:Q": 16}
for _k in range(1, 8):
    EXPECT[u"A1.%%d:I" %% _k] = 32
for _k in (8, 9):
    EXPECT[u"A1.%%d:Q" %% _k] = 32


def msg(text, error=False):
    print(text)
    try:
        system.write_message(Severity.Error if error else Severity.Information, text)
    except Exception:
        pass


def children(obj):
    return list(obj.get_children(False))


def find_all(obj, pred, out):
    for c in children(obj):
        if pred(c):
            out.append(c)
        find_all(c, pred, out)
    return out


def leaves(dev):
    """каналы-биты (сопоставляемые элементы без вложенных) в порядке отображения"""
    res = []

    def walk(data):
        if data.has_sub_elements:
            for sub in data:
                walk(sub)
        elif data.is_mappable_io:
            res.append(data)

    sets = [dev.device_parameters]
    try:
        for conn in dev.connectors:
            sets.append(conn.host_parameters)
    except Exception:
        pass
    for ps in sets:
        for p in ps:
            walk(p)
    return res


proj = projects.primary
if proj is None:
    raise Exception(u"Нет открытого проекта")

devs = find_all(proj, lambda o: o.is_device, [])
by_name = {}
for d in devs:
    by_name.setdefault(d.get_name(), []).append(d)

nodes = {}
for key, name in ((u"A1:I", u"DI"), (u"A1:Q", u"DQ")):
    if len(by_name.get(name, [])) == 1:
        nodes[key] = by_name[name][0]
bus = by_name.get(u"IO_Bus", [])
if len(bus) == 1:
    mods = [c for c in children(bus[0]) if c.is_device]
    msg(u"IO_Bus: модулей %%d: %%s" %% (len(mods), u", ".join(m.get_name() for m in mods)))
    for k, m in enumerate(mods, 1):
        nodes[u"A1.%%d:%%s" %% (k, u"I" if k <= 7 else u"Q")] = m
else:
    msg(u"Не найден узел IO_Bus", True)

plan, problems = [], 0
for key in sorted(EXPECT):
    dev = nodes.get(key)
    items = [r for r in MAP if u"%%s:%%s" %% (r[0], r[1]) == key]
    if dev is None:
        msg(u"%%s: узел не найден - %%d каналов пропущено" %% (key, len(items)), True)
        problems += 1
        continue
    lv = leaves(dev)
    msg(u"%%s -> %%s: каналов в устройстве %%d, ожидается %%d" %% (key, dev.get_name(), len(lv), EXPECT[key]))
    if len(lv) != EXPECT[key]:
        msg(u"  число каналов не совпадает - модуль пропущен, привяжите вручную по IO_map.csv", True)
        problems += 1
        continue
    for mod, kind, ch, var in items:
        data = lv[ch]
        plan.append((data, u"%%s.GVL_IO.%%s" %% (APP, var)))
        msg(u"  %%s%%d  %%-12s -> %%s" %% (kind, ch, data.identifier, var))

msg(u"Итого к привязке: %%d каналов, проблем: %%d" %% (len(plan), problems), problems > 0)
if APPLY:
    for data, var in plan:
        data.io_mapping.variable = var
    msg(u"Привязка выполнена. Сохраните проект и выполните компиляцию.")
else:
    msg(u"Режим проверки (APPLY = False): изменений не внесено.")
''' % {'table': table}

out = os.path.join(ROOT, 'machine_expert', 'map_io.py')
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, 'w', encoding='utf-8').write(SCRIPT)
print(os.path.relpath(out, ROOT), len(rows), 'каналов')
