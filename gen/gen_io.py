#!/usr/bin/env python3
"""Генерирует GVL_IO, PRG_Inputs, PRG_Outputs и таблицу IO из единой карты каналов.

Описания каналов: io_e3.txt (извлечено из Э3 ЕФБШ-649.01-АТХ).
Привязка к логике: таблицы MAP_IN / MAP_OUT ниже.
"""
import csv, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

desc = {}
for line in open(os.path.join(HERE, 'io_e3.txt'), encoding='utf-8'):
    p = line.rstrip('\n').split('|')
    if len(p) < 5:
        continue
    page, key, text, dev, eq = p[:5]
    desc[key] = dict(page=page, text=text, dev=dev, eq=eq)

# (модуль, канал, имя переменной, цель)
# цель: M:<мех>.<поле> | V:<клапан>.<поле> | B:<бункер>.<поле> | G:<переменная>; несколько через ','
# '|КЛЮЧ' после поля — полярность входа (логический сигнал = (физ. вход = константа))
POL = {
    'DSL': 'GVL_Const.CFG_DSL_OK',
    'DP': 'GVL_Const.CFG_DP_OK',
    'DPS': 'GVL_Const.CFG_DP_SCREW_OK',
    'DPC': 'GVL_Const.CFG_DP_CHAIN_OK',
    'DVU': 'GVL_Const.CFG_DVU_FULL',
    'DNU': 'GVL_Const.CFG_DNU_ON',
    'FCF': 'GVL_Const.CFG_FC_FAULT',
    'SA': 'GVL_Const.CFG_SA_LOCAL',
}


def rng(mod, a, b):
    return [(mod, f'I{i}') for i in range(a, b + 1)]


def group(pfx, m, chans, spec):
    rows = []
    for (mod, ch), (n, f) in zip(chans, spec):
        rows.append((mod, ch, f'DI_{pfx}_{n}', f'M:{m}.{f}' if f else ''))
    assert len(chans) == len(spec)
    return rows


NORIA = [('DKS', 'xDKS'), ('DSL1', 'xDSL1|DSL'), ('DSL2', 'xDSL2|DSL'), ('DP', 'xDP|DP'), ('SA', 'xLocal|SA'),
         ('SB_START', 'xLocStart'), ('SB_STOP', 'xLocStop'), ('SB_ESTOP', 'xEStop'), ('QF', 'xQF')]


def conv(dp):
    return [('DKS', 'xDKS'), ('DP', f'xDP|{dp}'), ('SA', 'xLocal|SA'), ('SB_START', 'xLocStart'),
            ('SB_STOP', 'xLocStop'), ('SB_END', 'xEStop'), ('QF', 'xQF')]


ZNORIA = [('DKS', 'xDKS'), ('RES', ''), ('SA', 'xLocal|SA'), ('SB_START', 'xLocStart'), ('SB_STOP', 'xLocStop'),
          ('SB_END', 'xEStop'), ('FAULT', 'xFcFault|FCF'), ('READY', 'xFcReady'), ('SF', 'xQF')]
GATE = [('OPENED', 'xFb1'), ('CLOSED', 'xFb2'), ('SA', 'xLocal|SA'), ('SB_OPEN', 'xLocOpen'), ('SB_CLOSE', 'xLocClose'),
        ('SB_STOP', 'xLocStop'), ('FAULT', 'xFcFault|FCF'), ('READY', 'xFcReady'), ('SF', 'xQF')]
FC = [('SF', 'xQF'), ('FAULT', 'xFcFault|FCF'), ('READY', 'xFcReady'), ('ESTOP', 'xEStop')]

MAP_IN = []
A = MAP_IN.append
# ---- A1 TM241CE40T ----
A(('A1', 'I0', 'DI_SYS_ON', 'G:GVL.xSysOnIn'))
for i in range(1, 11):
    A(('A1', f'I{i}', f'DI_ESTOP_{i}', f'G:GVL.aEStopIn[{i}]'))
A(('A1', 'I11', 'DI_FIRE_OK', 'G:GVL.xFireOkIn'))
A(('A1', 'I12', 'DI_PHASE_OK', 'G:GVL.xPhaseOkIn'))
A(('A1', 'I13', 'DI_A1_I13_RES', ''))
MAP_IN += group('N3', 'M_N3', rng('A1', 14, 22), NORIA)
A(('A1', 'I23', 'DI_B4_DVU', 'B:B_B4.xDVU|DVU'))
# ---- A1.1 ----
A(('A1.1', 'I0', 'DI_B4_DNU', 'B:B_B4.xDNU|DNU'))
A(('A1.1', 'I1', 'DI_MUZ5_QF', 'M:M_MUZ5.xQF'))
MAP_IN += group('MUZ5FD', 'M_MUZ5_FD', rng('A1.1', 2, 5), FC)
A(('A1.1', 'I6', 'DI_FAN6_QF', 'M:M_FAN6.xQF'))
A(('A1.1', 'I7', 'DI_SL6_DKS', 'M:M_SL6.xDKS'))
A(('A1.1', 'I8', 'DI_SL6_QF', 'M:M_SL6.xQF'))
MAP_IN += group('N7', 'M_N7', rng('A1.1', 9, 17), NORIA)
A(('A1.1', 'I18', 'DI_B8_DVU', 'B:B_B8.xDVU|DVU'))
A(('A1.1', 'I19', 'DI_B8_DNU', 'B:B_B8.xDNU|DNU'))
A(('A1.1', 'I20', 'DI_TOR9_QF', 'M:M_TOR9.xQF'))
MAP_IN += group('TOR9FD', 'M_TOR9_FD', rng('A1.1', 21, 24), FC)
A(('A1.1', 'I25', 'DI_FAN10_QF', 'M:M_FAN10.xQF'))
A(('A1.1', 'I26', 'DI_SL10_DKS', 'M:M_SL10.xDKS'))
A(('A1.1', 'I27', 'DI_SL10_QF', 'M:M_SL10.xQF'))
MAP_IN += group('N11', 'M_N11', rng('A1.1', 28, 31) + rng('A1.2', 0, 4), NORIA)
# ---- A1.2 ----
for v, a in (('V12_1', 5), ('V12_2', 8), ('V12_3', 11), ('V12_4', 14)):
    vv = v.replace('_', '')
    A(('A1.2', f'I{a}', f'DI_{vv}_SF', f'V:V_{v}.xSF'))
    A(('A1.2', f'I{a + 1}', f'DI_{vv}_POS1', f'V:V_{v}.xS1'))
    A(('A1.2', f'I{a + 2}', f'DI_{vv}_POS2', f'V:V_{v}.xS2'))
A(('A1.2', 'I17', 'DI_T131_SF', 'B:B_T13_1.xSF'))
A(('A1.2', 'I18', 'DI_T132_SF', 'B:B_T13_2.xSF'))
A(('A1.2', 'I19', 'DI_T131_DVU', 'B:B_T13_1.xDVU|DVU'))
A(('A1.2', 'I20', 'DI_T131_DNU', 'B:B_T13_1.xDNU|DNU'))
A(('A1.2', 'I21', 'DI_T132_DVU', 'B:B_T13_2.xDVU|DVU'))
A(('A1.2', 'I22', 'DI_T132_DNU', 'B:B_T13_2.xDNU|DNU'))
A(('A1.2', 'I23', 'DI_BT141_SF', 'M:M_BT14_1.xQF'))
A(('A1.2', 'I24', 'DI_BT141_FAULT', 'M:M_BT14_1.xFcFault|FCF'))
A(('A1.2', 'I25', 'DI_BT141_READY', 'M:M_BT14_1.xFcReady'))
A(('A1.2', 'I26', 'DI_BT14_ESTOP', 'M:M_BT14_1.xEStop,M:M_BT14_2.xEStop'))
A(('A1.2', 'I27', 'DI_BT142_SF', 'M:M_BT14_2.xQF'))
A(('A1.2', 'I28', 'DI_BT142_FAULT', 'M:M_BT14_2.xFcFault|FCF'))
A(('A1.2', 'I29', 'DI_BT142_READY', 'M:M_BT14_2.xFcReady'))
MAP_IN += group('N16', 'M_N16', rng('A1.2', 30, 31) + rng('A1.3', 0, 6), NORIA)
# ---- A1.3 ----
A(('A1.3', 'I7', 'DI_B17_DVU', 'B:B_B17.xDVU|DVU'))
A(('A1.3', 'I8', 'DI_B17_DNU', 'B:B_B17.xDNU|DNU'))
A(('A1.3', 'I9', 'DI_KSP18_QF', 'M:M_KSP18.xQF'))
MAP_IN += group('KSP18FD', 'M_KSP18_FD', rng('A1.3', 10, 13), FC)
A(('A1.3', 'I14', 'DI_FAN19_QF', 'M:M_FAN19.xQF'))
A(('A1.3', 'I15', 'DI_SL19_DKS', 'M:M_SL19.xDKS'))
A(('A1.3', 'I16', 'DI_SL19_QF', 'M:M_SL19.xQF'))
MAP_IN += group('N20', 'M_N20', rng('A1.3', 17, 25), NORIA)
MAP_IN += group('N21', 'M_N21', rng('A1.3', 26, 31) + rng('A1.4', 0, 2), NORIA)
# ---- A1.4 ----
A(('A1.4', 'I3', 'DI_B22_DVU', 'B:B_B22.xDVU|DVU'))
A(('A1.4', 'I4', 'DI_B22_DNU', 'B:B_B22.xDNU|DNU'))
A(('A1.4', 'I5', 'DI_SP24FAN_QF', 'M:M_SP24_FAN.xQF'))
MAP_IN += group('SP24DRV', 'M_SP24_DRV', rng('A1.4', 6, 9), FC)
A(('A1.4', 'I10', 'DI_FAN25_QF', 'M:M_FAN25.xQF'))
A(('A1.4', 'I11', 'DI_SL25_DKS', 'M:M_SL25.xDKS'))
A(('A1.4', 'I12', 'DI_SL25_QF', 'M:M_SL25.xQF'))
A(('A1.4', 'I13', 'DI_FAN28_QF', 'M:M_FAN28.xQF'))
A(('A1.4', 'I14', 'DI_SL28_DKS', 'M:M_SL28.xDKS'))
A(('A1.4', 'I15', 'DI_SL28_QF', 'M:M_SL28.xQF'))
MAP_IN += group('SH31', 'M_SH31', rng('A1.4', 16, 22), conv('DPS'))
MAP_IN += group('SH32', 'M_SH32', rng('A1.4', 23, 29), conv('DPS'))
MAP_IN += group('SH33', 'M_SH33', rng('A1.4', 30, 31) + rng('A1.5', 0, 4), conv('DPS'))
# ---- A1.5 ----
MAP_IN += group('KC34', 'M_KC34', rng('A1.5', 5, 11), conv('DPC'))
MAP_IN += group('KC35', 'M_KC35', rng('A1.5', 12, 18), conv('DPC'))
MAP_IN += group('KC36', 'M_KC36', rng('A1.5', 19, 25), conv('DPC'))
MAP_IN += group('SH30', 'M_SH30', rng('A1.5', 26, 31) + rng('A1.6', 0, 0), conv('DPS'))
# ---- A1.6 ----
MAP_IN += group('ZN26', 'M_ZN26', rng('A1.6', 1, 9), ZNORIA)
A(('A1.6', 'I10', 'DI_V49_ON', 'V:V_V49.xS1'))
A(('A1.6', 'I11', 'DI_V49_OFF', 'V:V_V49.xS2'))
MAP_IN += group('ZN29', 'M_ZN29', rng('A1.6', 12, 20), ZNORIA)
MAP_IN += group('GATE1', 'M_GATE1', rng('A1.6', 21, 29), GATE)
A(('A1.6', 'I30', 'DI_B27_DVU1', 'B:B_B27.xDVU|DVU'))
A(('A1.6', 'I31', 'DI_B27_DVU2', 'B:B_B27.xDNU|DNU'))
# ---- A1.7 ----
A(('A1.7', 'I0', 'DI_FS27_ASP_SF', 'G:GVL.xFsAspPwrIn'))
A(('A1.7', 'I1', 'DI_FS27_SF', 'M:M_FS27.xQF'))
A(('A1.7', 'I2', 'DI_FS27_STATUS', 'M:M_FS27.xFb1'))
A(('A1.7', 'I3', 'DI_FS27_REMOTE', 'M:M_FS27.xFb2'))
A(('A1.7', 'I4', 'DI_FS27_ERROR', 'M:M_FS27.xErr'))
A(('A1.7', 'I5', 'DI_DRYER_SF', 'G:GVL.xDryerOkIn'))
A(('A1.7', 'I6', 'DI_COMPR_SF', 'G:GVL.xComprOkIn'))
A(('A1.7', 'I7', 'DI_COMPR2_SF', 'G:GVL.xCompr2OkIn'))
A(('A1.7', 'I8', 'DI_A17_I8_RES', ''))
A(('A1.7', 'I9', 'DI_A17_I9_RES', ''))

OUT_A1 = ['DO_SIREN:G:GVL.qSiren', 'DO_LAMP_ALARM:G:GVL.qLamp', 'DO_N3_RUN:M:M_N3.qRun', 'DO_MUZ5_RUN:M:M_MUZ5.qRun',
          'DO_MUZ5FD_POWER:M:M_MUZ5_FD.qPower', 'DO_MUZ5FD_RESET:M:M_MUZ5_FD.qReset', 'DO_MUZ5FD_RUN:M:M_MUZ5_FD.qRun',
          'DO_FAN6_RUN:M:M_FAN6.qRun', 'DO_SL6_RUN:M:M_SL6.qRun', 'DO_N7_RUN:M:M_N7.qRun', 'DO_TOR9_RUN:M:M_TOR9.qRun',
          'DO_TOR9FD_POWER:M:M_TOR9_FD.qPower', 'DO_TOR9FD_RESET:M:M_TOR9_FD.qReset', 'DO_TOR9FD_RUN:M:M_TOR9_FD.qRun',
          'DO_FAN10_RUN:M:M_FAN10.qRun', 'DO_SL10_RUN:M:M_SL10.qRun']
OUT_A18 = ['DO_N11_RUN:M:M_N11.qRun',
           'DO_V121_POS1:V:V_V12_1.q1', 'DO_V121_POS2:V:V_V12_1.q2',
           'DO_V122_POS1:V:V_V12_2.q1', 'DO_V122_POS2:V:V_V12_2.q2',
           'DO_V123_POS1:V:V_V12_3.q1', 'DO_V123_POS2:V:V_V12_3.q2',
           'DO_V124_POS1:V:V_V12_4.q1', 'DO_V124_POS2:V:V_V12_4.q2',
           'DO_A18_Q9_RES:',
           'DO_BT141_POWER:M:M_BT14_1.qPower', 'DO_BT141_RESET:M:M_BT14_1.qReset', 'DO_BT141_RUN:M:M_BT14_1.qRun',
           'DO_BT142_POWER:M:M_BT14_2.qPower', 'DO_BT142_RESET:M:M_BT14_2.qReset', 'DO_BT142_RUN:M:M_BT14_2.qRun',
           'DO_N16_RUN:M:M_N16.qRun', 'DO_KSP18_RUN:M:M_KSP18.qRun',
           'DO_KSP18FD_POWER:M:M_KSP18_FD.qPower', 'DO_KSP18FD_RESET:M:M_KSP18_FD.qReset',
           'DO_KSP18FD_RUN:M:M_KSP18_FD.qRun',
           'DO_FAN19_RUN:M:M_FAN19.qRun', 'DO_SL19_RUN:M:M_SL19.qRun', 'DO_N20_RUN:M:M_N20.qRun',
           'DO_N21_RUN:M:M_N21.qRun', 'DO_SP24FAN_RUN:M:M_SP24_FAN.qRun',
           'DO_SP24DRV_POWER:M:M_SP24_DRV.qPower', 'DO_SP24DRV_RESET:M:M_SP24_DRV.qReset',
           'DO_SP24DRV_RUN:M:M_SP24_DRV.qRun',
           'DO_FAN25_RUN:M:M_FAN25.qRun', 'DO_SL25_RUN:M:M_SL25.qRun', 'DO_FAN28_RUN:M:M_FAN28.qRun']
OUT_A19 = ['DO_SL28_RUN:M:M_SL28.qRun', 'DO_SH31_RUN:M:M_SH31.qRun', 'DO_SH32_RUN:M:M_SH32.qRun',
           'DO_SH33_RUN:M:M_SH33.qRun', 'DO_KC34_RUN:M:M_KC34.qRun', 'DO_KC35_RUN:M:M_KC35.qRun',
           'DO_KC36_RUN:M:M_KC36.qRun', 'DO_SH30_RUN:M:M_SH30.qRun',
           'DO_ZN26_POWER:M:M_ZN26.qPower', 'DO_ZN26_RUN:M:M_ZN26.qRun', 'DO_ZN26_RESET:M:M_ZN26.qReset',
           'DO_V49_ON:V:V_V49.q1', 'DO_V49_OFF:V:V_V49.q2',
           'DO_ZN29_POWER:M:M_ZN29.qPower', 'DO_ZN29_RUN:M:M_ZN29.qRun', 'DO_ZN29_RESET:M:M_ZN29.qReset',
           'DO_GATE1_POWER:M:M_GATE1.qPower', 'DO_GATE1_OPEN:M:M_GATE1.qOpen', 'DO_GATE1_RESET:M:M_GATE1.qReset',
           'DO_GATE1_CLOSE:M:M_GATE1.qClose',
           'DO_FS27_ON:M:M_FS27.qOn', 'DO_FS27_OFF:M:M_FS27.qOff', 'DO_FS27_ENABLE:M:M_FS27.qEnable',
           'DO_A19_Q23_RES:', 'DO_A19_Q24_RES:']
MAP_OUT = []
for mod, lst in (('A1', OUT_A1), ('A1.8', OUT_A18), ('A1.9', OUT_A19)):
    for k, s in enumerate(lst):
        name, _, tgt = s.partition(':')
        MAP_OUT.append((mod, f'Q{k}', name, tgt))


def target_expr(t):
    kind, _, rest = t.partition(':')
    obj, _, field = rest.rpartition('.')
    arr = {'M': 'Mech', 'V': 'Valve', 'B': 'Bunker'}
    if kind in arr:
        io = 'In' if field.startswith('x') else 'Out'
        return f'GVL.a{arr[kind]}{io}[GVL_Const.{obj}].{field}'
    if kind == 'G':
        return rest
    raise ValueError(t)


def comment(mod, ch):
    d = desc.get(f'{mod}.{ch}')
    if not d:
        return 'резерв'
    s = f"{d['text']}; {d['dev']}; {d['eq']}; лист {d['page']}"
    return s.replace('(*', '(').replace('*)', ')')


def wire(mod, ch):
    letter = 'X' if ch[0] == 'I' else 'Y'
    pre = '' if mod == 'A1' else mod.split('.')[1]
    return f'{pre}{letter}{ch[1:]}'


def check():
    seen = set()
    for mod, ch, name, tgt in MAP_IN + MAP_OUT:
        assert (mod, ch) not in seen, (mod, ch)
        seen.add((mod, ch))
    names = [r[2] for r in MAP_IN + MAP_OUT]
    assert len(names) == len(set(names)), 'duplicate names'
    need = [('A1', 'I', 24), ('A1', 'Q', 16), ('A1.8', 'Q', 32), ('A1.9', 'Q', 25)] + \
           [(f'A1.{i}', 'I', 32) for i in range(1, 7)] + [('A1.7', 'I', 10)]
    for mod, t, n in need:
        for k in range(n):
            assert (mod, f'{t}{k}') in seen, (mod, t, k)
    # каждое описание из Э3 должно быть привязано
    for key in desc:
        mod, _, ch = key.rpartition('.')
        assert (mod, ch) in seen, key


def main():
    check()
    g = ['(* Сгенерировано gen/gen_io.py из Э3 ЕФБШ-649.01-АТХ. Не редактировать вручную.',
         '   Привязка к каналам: Machine Expert -> модуль -> "Соотнесение входов/выходов" (I/O Mapping) ->',
         '   переменная канала = Application.GVL_IO.<имя> (см. doc/IO_map.csv). *)',
         'VAR_GLOBAL']
    for lst in (MAP_IN, MAP_OUT):
        prev = None
        for mod, ch, name, tgt in lst:
            if mod != prev:
                typ = 'TM241CE40T' if mod == 'A1' else ('TM3DI32K' if ch[0] == 'I' else 'TM3DQ32TK')
                g.append(f'    (* ---- {mod} {typ} ---- *)')
                prev = mod
            g.append(f'    {name:<20}: BOOL; (* {mod} {ch} [{wire(mod, ch)}] {comment(mod, ch)} *)')
    g.append('END_VAR')
    open(os.path.join(ROOT, 'src/GVL/GVL_IO.st'), 'w', encoding='utf-8').write('\n'.join(g) + '\n')

    p = ['(* Сгенерировано gen/gen_io.py. Физические входы -> логические сигналы.',
         '   Полярность датчиков - константы CFG_* в GVL_Const. *)',
         'PROGRAM PRG_Inputs', '']
    for mod, ch, name, tgt in MAP_IN:
        for t in filter(None, tgt.split(',')):
            t, _, pol = t.partition('|')
            rhs = f'(GVL_IO.{name} = {POL[pol]})' if pol else f'GVL_IO.{name}'
            p.append(f'{target_expr(t)} := {rhs};')
    p.append('END_PROGRAM')
    open(os.path.join(ROOT, 'src/POU/PRG_Inputs.st'), 'w', encoding='utf-8').write('\n'.join(p) + '\n')

    q = ['(* Сгенерировано gen/gen_io.py. Логические команды -> физические выходы. *)',
         'PROGRAM PRG_Outputs', '']
    for mod, ch, name, tgt in MAP_OUT:
        q.append(f'GVL_IO.{name} := {target_expr(tgt) if tgt else "FALSE"};')
    q.append('END_PROGRAM')
    open(os.path.join(ROOT, 'src/POU/PRG_Outputs.st'), 'w', encoding='utf-8').write('\n'.join(q) + '\n')

    with open(os.path.join(ROOT, 'doc/IO_map.csv'), 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f, delimiter=';')
        w.writerow(['Модуль', 'Канал', 'Провод', 'Переменная GVL_IO', 'Логический сигнал', 'Описание (Э3)',
                    'Обозначение', 'Оборудование', 'Лист Э3'])
        for mod, ch, name, tgt in MAP_IN + MAP_OUT:
            d = desc.get(f'{mod}.{ch}', {})
            w.writerow([mod, ch, wire(mod, ch), name, tgt.replace('GVL.', ''), d.get('text', 'резерв'),
                        d.get('dev', ''), d.get('eq', ''), d.get('page', '')])
    print('inputs', len(MAP_IN), 'outputs', len(MAP_OUT))


if __name__ == '__main__':
    main()
