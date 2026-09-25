"""Сценарии проверки логики. Запуск: python3 test_scenarios.py [имя ...] (без аргументов - все)."""
import sys

from plant import Plant

FAILS = []


def check(cond, msg):
    print(('  OK   ' if cond else '  FAIL ') + msg)
    if not cond:
        FAILS.append(msg)


class T:
    def __init__(self):
        self.p = Plant()
        self.c, self.g, self.h = self.p.c, self.p.gvl, self.p.hmi
        self.names = {self.c[n]: n for n in self.p.mechs}
        self.p.run_for(1000)

    def m(self, name):
        return self.c[name]

    def route_cmd(self, r, cmd=1):
        self.h['aHmiRoute'][r]['wCmd'] = cmd
        self.p.step(100)

    def rsts(self, r):
        return self.h['aHmiRoute'][r]['wSts']

    def start_route(self, r, limit=300000):
        self.route_cmd(r)
        return self.p.run_for(limit, until=lambda: self.rsts(r) & self.c['RS_ALLRUN'])

    def members(self, r):
        return [i for i in range(1, 38) if self.g['aMember'][r, i]]

    def running(self):
        return [self.names[i] for i in range(1, 38) if self.g['aRun'][i]]

    def reset(self):
        self.h['stHmiG']['wCmd'] = self.c['G_RESET']
        self.p.run_for(1500)


def sc_all_routes():
    """каждый маршрут отдельно: пуск до полной работы, останов до полной остановки"""
    for r in range(1, 12):
        t = T()
        ok = t.start_route(r)
        run = set(t.running())
        mem = {t.names[i] for i in t.members(r)}
        check(ok and run == mem, f'маршрут {r}: все {len(mem)} механизмов в работе за {t.p.t / 1000:.0f} с, лишних нет'
              + ('' if run == mem else f' лишние={run - mem} нет={mem - run}'))
        t.route_cmd(r)
        t.p.run_for(300000, until=lambda: t.g['aRouteState'][r] == t.c['RST_IDLE'])
        check(t.g['aRouteState'][r] == 0 and not t.running(), f'маршрут {r}: остановлен полностью')


def sc_order():
    """маршрут 1: пуск от последнего к первому, останов от первого к последнему"""
    t = T()
    first_on, first_off = {}, {}
    t.route_cmd(1)
    while not (t.rsts(1) & t.c['RS_ALLRUN']) and t.p.t < 300000:
        t.p.step(100)
        for i in range(1, 38):
            if t.g['aRun'][i]:
                first_on.setdefault(i, t.p.t)
    bad = [(t.names[l['iFrom']], t.names[l['iTo']]) for l in (t.g['aLinks'][k] for k in range(1, t.g['nLinks'] + 1))
           if l['eTo'] == 0 and l['iFrom'] in first_on and first_on[l['iFrom']] < first_on.get(l['iTo'], 1e9)]
    check(not bad, 'пуск: каждый механизм запущен после того, на который он подаёт ' + str(bad))
    t.route_cmd(1)
    while t.g['aRouteState'][1] != 0 and t.p.t < 900000:
        t.p.step(100)
        for i in range(1, 38):
            if not t.g['aRun'][i]:
                first_off.setdefault(i, t.p.t)
    bad = [(t.names[l['iFrom']], t.names[l['iTo']]) for l in (t.g['aLinks'][k] for k in range(1, t.g['nLinks'] + 1))
           if l['eTo'] == 0 and l['iFrom'] in first_off and first_off[l['iFrom']] > first_off.get(l['iTo'], 0)]
    check(not bad, 'останов: каждый механизм остановлен не раньше подающего на него ' + str(bad))


def sc_prestart():
    """предпусковой сигнал, отмена пуска повторным нажатием"""
    t = T()
    t.route_cmd(6)
    siren = False
    for _ in range(50):
        t.p.step(100)
        siren |= t.p.io['DO_SIREN']
    check(t.g['aRouteState'][6] == t.c['RST_PRESTART'] and siren, 'во время предпуска звучит сирена, механизмы стоят')
    check(not t.running(), 'в предпуске механизмы не запускаются')
    t.route_cmd(6)
    t.p.run_for(1000)
    check(t.g['aRouteState'][6] == 0 and not t.p.io['DO_SIREN'], 'повторное нажатие в предпуске - отмена, сирена снята')


def sc_conflict():
    """запреты одновременной работы маршрутов"""
    t = T()
    t.start_route(6)
    t.route_cmd(1)
    check(t.g['aRouteState'][1] == 0 and t.h['aHmiRoute'][1]['iNotReady'] == -2, 'маршрут 1 при работе 6 не запускается (конфликт)')
    ok = t.start_route(10)
    check(ok and t.g['aRouteState'][6] == 3, 'маршруты 6 и 10 работают одновременно')
    t.route_cmd(9)
    check(t.g['aRouteState'][9] == 0, 'маршрут 9 при работе 10 не запускается')
    t.h['stHmiG']['wCmd'] = t.c['G_STOPALL']
    t.p.run_for(300000, until=lambda: t.g['aRouteState'][6] == 0 and t.g['aRouteState'][10] == 0)
    check(not t.running() and t.g['aRouteState'][6] == 0 and t.g['aRouteState'][10] == 0, '"Стоп всех маршрутов" останавливает оба')


def sc_bunker_full():
    """ДВУ оперативного бункера поз.4: пауза подачи на бункер, остальное работает; затем автоповтор"""
    t = T()
    t.start_route(6)
    t.p.force[('B', 'B_B4', 'xDVU')] = True
    t.p.run_for(60000)
    up = {'M_GATE1', 'M_N3'}
    run = set(t.running())
    check(not (up & run), 'участок до бункера (заслонка, нория 3) остановлен: ' + str(up & run))
    check({'M_MUZ5', 'M_N7', 'M_N11', 'M_TOR9'} <= run, 'участки после бункера продолжают работу')
    check(t.g['aRouteState'][6] == 3 and t.rsts(6) & t.c['RS_PAUSED'] and not t.g['aRouteFault'][6], 'маршрут в работе, признак "пауза", без аварии')
    check(t.p.gate == 0.0, 'заслонка поз.1 закрылась')
    del t.p.force[('B', 'B_B4', 'xDVU')]
    ok = t.p.run_for(120000, until=lambda: t.p.gate == 1.0 and not t.rsts(6) & t.c['RS_PAUSED'])
    check(ok and t.g['aRun'][t.m('M_N3')] and t.rsts(6) & t.c['RS_ALLRUN'], 'после освобождения бункера участок запускается снова, заслонка открыта')


def sc_mech_alarm():
    """сбег ленты нории поз.7 во время работы маршрута: авария, останов маршрута, сброс"""
    t = T()
    t.start_route(6)
    n7 = t.m('M_N7')
    t.p.force[('M', 'M_N7', 'xDSL1')] = False
    t.p.run_for(3000)
    check(t.h['aHmiMech'][n7]['wAlm'] & t.c['A_DSL1'] and not t.g['aRun'][n7], 'нория 7: авария "сбег ленты 1", отключена')
    check(not t.g['aRun'][t.m('M_MUZ5')], 'подающий МУЗ-8М отключен сразу (блокировка)')
    check(t.g['aRouteFault'][6], 'маршрут 6 - авария')
    check(t.p.io['DO_SIREN'], 'сирена включена')
    t.p.run_for(300000, until=lambda: t.g['aRouteState'][6] == 0)
    check(t.g['aRouteState'][6] == 0 and not t.running(), 'маршрут остановлен полностью')
    t.route_cmd(6)
    check(t.g['aRouteState'][6] == 0 and t.h['aHmiRoute'][6]['iNotReady'] == n7, 'повторный пуск запрещён, панель показывает норию 7')
    t.reset()
    check(t.g['aAlarm'][n7], 'сброс при сохраняющейся неисправности не снимает аварию')
    del t.p.force[('M', 'M_N7', 'xDSL1')]
    t.reset()
    check(not t.g['aAlarm'][n7] and not t.p.io['DO_SIREN'], 'после устранения и сброса авария снята, сирена выключена')
    check(t.start_route(6), 'маршрут снова запускается')


def sc_dks():
    """обрыв (нет импульсов ДКС) шлюзового затвора поз.10"""
    t = T()
    t.start_route(6)
    i = t.m('M_SL10')
    t.p.fail_run.add(i)
    t.p.run_for(2000)
    check(not t.h['aHmiMech'][i]['wAlm'] & t.c['A_DKS'], 'до истечения 3 с авария ДКС не формируется')
    t.p.run_for(1500)
    check(t.h['aHmiMech'][i]['wAlm'] & t.c['A_DKS'] and t.g['aRouteFault'][6], 'через 3 с - авария ДКС, маршрут остановлен')


def sc_fc_fault():
    """авария ПЧ привода СП-200, сброс ПЧ импульсом с панели"""
    t = T()
    t.start_route(10)
    i = t.m('M_SP24_DRV')
    t.p.force[('M', 'M_SP24_DRV', 'xFcFault')] = True
    t.p.run_for(500)
    check(t.h['aHmiMech'][i]['wAlm'] & t.c['A_FC'] and not t.p.out('M', 'M_SP24_DRV', 'qRun'), 'авария ПЧ: пуск снят')
    check(t.g['aRouteFault'][10] and t.g['aRouteState'][10] == 4, 'маршрут 10 - авария, останов')
    del t.p.force[('M', 'M_SP24_DRV', 'xFcFault')]
    t.h['stHmiG']['wCmd'] = t.c['G_RESET']
    pulse = False
    for _ in range(15):
        t.p.step(100)
        pulse |= t.p.out('M', 'M_SP24_DRV', 'qReset')
    check(pulse and not t.g['aAlarm'][i], 'сброс: импульс сброса на ПЧ, авария снята')


def sc_estop():
    """аварийный стоп в цехе: все механизмы отключаются немедленно"""
    t = T()
    t.start_route(6)
    t.start_route(10)
    t.p.force[('G', 'aEStopIn[2]', '')] = False
    t.p.step(100)
    t.p.step(100)
    check(not t.running() or t.running() == ['M_GATE1'], 'через 2 цикла все двигатели остановлены: ' + str(t.running()))
    check(t.g['aRouteState'][6] in (0, 4) and t.g['aRouteFault'][6] and t.g['aRouteFault'][10], 'маршруты - авария')
    check(not t.p.out('M', 'M_GATE1', 'qOpen') and t.p.out('M', 'M_GATE1', 'qClose'), 'заслонка поз.1 закрывается')
    t.p.run_for(8000)
    check(t.p.gate == 0.0 and t.g['aRouteState'][6] == 0, 'заслонка поз.1 закрылась, маршрут остановлен')
    del t.p.force[('G', 'aEStopIn[2]', '')]
    t.p.run_for(2000)
    t.route_cmd(6)
    check(t.g['aRouteState'][6] == 0 and t.h['aHmiRoute'][6]['iNotReady'] == -1, 'без сброса пуск запрещён')
    t.reset()
    check(t.start_route(6), 'после сброса маршрут запускается')


def sc_sysoff():
    """отключение цепи управления (1K1)"""
    t = T()
    t.start_route(6)
    t.p.force[('G', 'xSysOnIn', '')] = False
    t.p.run_for(300)
    check(not t.running() or t.running() == ['M_GATE1'], 'все механизмы остановлены')
    del t.p.force[('G', 'xSysOnIn', '')]
    t.p.run_for(1000)
    check(not t.running() or t.running() == ['M_GATE1'], 'после восстановления цепи ничего не запускается само')


def sc_valve_timeout():
    """переключатель потока поз.12(1) не дошёл до положения"""
    t = T()
    t.p.force[('V', 'V_V12_1', 'xS2')] = False
    t.route_cmd(1)
    t.p.run_for(50000)
    check(t.h['aHmiValve'][1]['wAlm'] & t.c['VA_TIMEOUT'] and t.g['aRouteFault'][1], 'авария "не дошёл" за 30 с, маршрут - авария')
    t.p.run_for(300000, until=lambda: t.g['aRouteState'][1] == 0)
    check(t.g['aRouteState'][1] == 0 and not t.running(), 'маршрут остановлен, механизмы не запускались')


def sc_valve_lost():
    """потеря положения клапана во время работы маршрута"""
    t = T()
    t.start_route(10)
    t.p.force[('V', 'V_V12_4', 'xS1')] = False
    t.p.run_for(500)
    check(t.g['aRouteFault'][10] and t.g['aRouteState'][10] == 4, 'маршрут переведён в останов с аварией')
    check(not t.g['aRun'][t.m('M_N21')], 'нория 21 (подаёт на клапан) отключена блокировкой')


def sc_manual():
    """ручной режим с панели: блокировка пуска при стоящем последующем механизме, наладка"""
    t = T()
    fd, muz, n7 = t.m('M_MUZ5_FD'), t.m('M_MUZ5'), t.m('M_N7')
    C = t.c
    for i in (fd, muz, n7):
        t.h['aHmiMech'][i]['wCmd'] = C['C_MANUAL']
    t.p.step(100)
    t.h['aHmiMech'][fd]['wCmd'] = C['C_MANUAL'] | C['C_START']
    t.p.run_for(500)
    check(not t.g['aRun'][fd], 'битер МУЗ вручную не запускается: стоит МУЗ-8М')
    check(not t.h['aHmiMech'][fd]['wSts'] & C['S_SUCC_OK'], 'на панели нет признака "пуск разрешён"')
    t.h['aHmiMech'][n7]['wCmd'] = C['C_MANUAL'] | C['C_START']
    t.p.run_for(500)
    check(t.g['aRun'][n7], 'нория 7 (подаёт в бункер поз.8) запускается вручную')
    t.h['stHmiG']['wCmd'] = C['G_SETUP']
    t.h['aHmiMech'][muz]['wCmd'] = C['C_MANUAL'] | C['C_START']
    t.p.run_for(500)
    check(t.g['aRun'][muz], 'в режиме наладки МУЗ запускается без блокировок (аспирация стоит)')
    t.h['stHmiG']['wCmd'] = 0
    t.p.run_for(300)
    check(not t.g['aRun'][muz] and t.h['aHmiMech'][muz]['wSts'] & C['S_SEQ_TRIP'],
          'выход из наладки: МУЗ отключен блокировкой, признак на панели')
    t.h['aHmiMech'][n7]['wCmd'] = C['C_MANUAL'] | C['C_STOP']
    t.p.run_for(300)
    check(not t.g['aRun'][n7], 'стоп с панели')
    t.route_cmd(6)
    check(t.h['aHmiRoute'][6]['iNotReady'] == fd, 'маршрут не запускается, пока механизмы в ручном режиме')


def sc_local():
    """местный пост нории 21: ключ в "ручн.", кнопки Пуск/Стоп"""
    t = T()
    i = t.m('M_N21')
    f = t.p.force
    f[('M', 'M_N21', 'xLocal')] = True
    t.p.step(100)
    f[('M', 'M_N21', 'xLocStart')] = True
    t.p.run_for(300)
    f[('M', 'M_N21', 'xLocStart')] = False
    t.p.run_for(300)
    check(t.g['aRun'][i] and t.h['aHmiMech'][i]['iState'] == 5, 'пуск с местного поста')
    f[('M', 'M_N21', 'xLocStop')] = False
    t.p.run_for(300)
    check(not t.g['aRun'][i] and not t.g['aAlarm'][i], 'стоп с местного поста, без аварии')
    f[('M', 'M_N21', 'xLocStop')] = True
    f[('M', 'M_N21', 'xLocal')] = False
    t.p.run_for(500)
    ok = t.start_route(10)
    check(ok, f'после возврата ключа в "автом." маршрут 10 запускается (не готов: {t.h["aHmiRoute"][10]["iNotReady"]})')
    f[('M', 'M_N21', 'xLocStop')] = False
    t.p.run_for(300)
    check(t.h['aHmiMech'][i]['wAlm'] & t.c['A_LOCSTOP'] and t.g['aRouteFault'][10],
          'местный "Стоп" при работе в маршруте: авария, маршрут остановлен')


def sc_fs():
    """фотосепаратор: нет сжатого воздуха - маршрут с ФС не готов; импульсы вкл/выкл"""
    t = T()
    t.p.force[('G', 'xComprOkIn', '')] = False
    t.p.run_for(300)
    t.route_cmd(11)
    check(t.h['aHmiRoute'][11]['iNotReady'] == t.m('M_FS27'), 'маршрут 11 не готов: нет воздуха для ФС')
    del t.p.force[('G', 'xComprOkIn', '')]
    t.p.run_for(300)
    check(t.start_route(11) and t.p.fs_on and t.p.out('M', 'M_FS27', 'qEnable'), 'ФС включён импульсом, секции разрешены')
    t.route_cmd(11)
    t.p.run_for(300000, until=lambda: t.g['aRouteState'][11] == 0)
    check(not t.p.fs_on, 'ФС выключен импульсом "Выключить"')


def sc_retain_hmi():
    """уставки с панели: запись задержки, ограничение диапазона"""
    t = T()
    i = t.m('M_N3')
    r = t.p.sim.g('GVL_Retain')
    check(t.h['aHmiMech'][i]['uTOn'] == 3, 'значение по умолчанию выведено на панель')
    t.h['aHmiMech'][i]['uTOn'] = 12
    t.p.step(100)
    check(r['aMechPar'][i]['uTOn'] == 12, 'новая уставка сохранена в RETAIN')
    t.h['aHmiMech'][i]['uTOn'] = 9999
    t.p.step(100)
    check(r['aMechPar'][i]['uTOn'] <= 3600, 'значение вне диапазона ограничено')


ALL = {k[3:]: v for k, v in globals().items() if k.startswith('sc_')}

if __name__ == '__main__':
    for name in sys.argv[1:] or ALL:
        print(f'== {name}: {ALL[name].__doc__}')
        ALL[name]()
    print('ИТОГ:', 'ошибок нет' if not FAILS else f'{len(FAILS)} ошибок')
    sys.exit(1 if FAILS else 0)
