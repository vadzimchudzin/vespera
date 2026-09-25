#!/usr/bin/env python3
"""Генерирует doc/HMI_map.md (карта регистров Modbus для панели) из DUT и GVL_Const."""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(p):
    return open(os.path.join(ROOT, p), encoding='utf-8').read()


def fields(dut):
    """[(смещение, имя, тип, комментарий)] для структуры из 16-битных полей"""
    out, off = [], 0
    for m in re.finditer(r'^\s*(\w+)\s*:\s*([^;]+);\s*(?:\(\*(.*?)\*\))?', read(f'src/DUT/{dut}.st'), re.M | re.S):
        name, typ, com = m.group(1), m.group(2).strip(), ' '.join((m.group(3) or '').split())
        com = re.sub(r'^\+\d+\s*', '', com)
        a = re.match(r'ARRAY\[(\d+)\.\.(\d+)\] OF (\w+)', typ)
        n = int(a.group(2)) - int(a.group(1)) + 1 if a else 1
        out.append((off, name, typ, com))
        off += n
    return out, off


const = read('src/GVL/GVL_Const.st')


def masks(prefix):
    rows = []
    for m in re.finditer(rf'^\s*({prefix}\w+)\s*:\s*WORD\s*:=\s*16#([0-9A-F]+);[ \t]*(?:\(\*(.*?)\*\))?', const, re.M):
        v = int(m.group(2), 16)
        bit = v.bit_length() - 1 if v and v & (v - 1) == 0 else None
        rows.append((m.group(1), v, bit, (m.group(3) or '').strip()))
    return rows


def objects(prefix):
    return [(int(m.group(2)), m.group(1), m.group(3).strip()) for m in
            re.finditer(rf'^\s*({prefix}\w+)\s*:\s*INT\s*:=\s*(\d+);\s*\(\*(.*?)\*\)', const, re.M)]


L = ['# Карта регистров панели оператора (Modbus TCP)', '',
     'ЕФБШ-649.01-АТХ, ЛПЗС-5 ССЦ "Золотой початок". Сгенерировано `gen/gen_hmi_map.py` из исходников — '
     'не редактировать вручную.', '',
     'Контроллер TM241CE40T — Modbus TCP сервер, порт 502, регистры хранения (holding, функции 3/6/16) '
     'соответствуют `%MW` с тем же номером. Все поля 16-битные. Команды (`wCmd`) — импульсные биты: '
     'панель устанавливает бит, контроллер сбрасывает после обработки (кроме помеченных «пока нажато»/режимов). '
     'Уставки можно и читать, и записывать: контроллер сохраняет их в RETAIN и ограничивает диапазон.', '']

BLOCKS = [('Общий блок', 'ST_GlobHmi', 0, 1, None, ['G_', 'GS_', 'GA_', 'GW_']),
          ('Маршруты', 'ST_RouteHmi', 100, 11, None, ['RC_', 'RS_']),
          ('Механизмы', 'ST_MechHmi', 200, 37, 'M_', ['C_', 'S_', 'A_', 'BY_']),
          ('Переключатели потока', 'ST_ValveHmi', 1000, 5, 'V_', ['VC_', 'VS_', 'VA_']),
          ('Бункеры', 'ST_BunkerHmi', 1100, 7, 'B_', ['BS_', 'BA_', 'BY_DVU'])]

for title, dut, base, n, objp, mp in BLOCKS:
    fl, size = fields(dut)
    L += [f'## {title}: %MW{base}' + (f' + (номер−1)×{size}' if n > 1 else ''), '',
          '| Смещение | Поле | Тип | Назначение |', '|---|---|---|---|']
    L += [f'| +{o} | `{nm}` | {t} | {c} |' for o, nm, t, c in fl if not nm.startswith('uRes')]
    L.append('')
    if objp:
        L += ['| № | Объект | Базовый адрес |', '|---|---|---|']
        L += [f'| {i} | {c} | %MW{base + (i - 1) * size} |' for i, _, c in objects(objp)]
        L.append('')
    if dut == 'ST_RouteHmi':
        L += ['| № | Маршрут | Базовый адрес |', '|---|---|---|']
        seen = set()
        for m in re.finditer(r'^\s{7}(\d+)\s+(.+)$', const, re.M):
            i = int(m.group(1))
            if 1 <= i <= 11 and i not in seen:
                seen.add(i)
                L.append(f'| {i} | {m.group(2).strip()} | %MW{base + (i - 1) * size} |')
        L.append('')
    for p in mp:
        rows = masks(p) if not p.endswith('DVU') else [r for r in masks('BY_') if r[0] == p]
        if p == 'BY_':
            rows = [r for r in rows if r[0] != 'BY_DVU']
        if not rows:
            continue
        L += [f'Биты `{p}*`:', '', '| Бит | Маска | Имя | Назначение |', '|---|---|---|---|']
        L += [f'| {b if b is not None else "—"} | 16#{v:04X} | {nm} | {c} |' for nm, v, b, c in rows]
        L.append('')

open(os.path.join(ROOT, 'doc', 'HMI_map.md'), 'w', encoding='utf-8').write('\n'.join(L))
print('doc/HMI_map.md:', len(L), 'строк')
