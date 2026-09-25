"""Модель объекта для проверки программы в симуляторе: работает на уровне физических
каналов GVL_IO по карте doc/IO_map.csv (с учётом полярности датчиков)."""
import csv
import os

from stsim import Sim

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POL = {'DSL': 'CFG_DSL_OK', 'DP': 'CFG_DP_OK', 'DPS': 'CFG_DP_SCREW_OK', 'DPC': 'CFG_DP_CHAIN_OK',
       'DVU': 'CFG_DVU_FULL', 'DNU': 'CFG_DNU_ON', 'FCF': 'CFG_FC_FAULT', 'SA': 'CFG_SA_LOCAL'}


class Plant:
    def __init__(self):
        self.sim = Sim(os.path.join(ROOT, 'src'))
        self.io = self.sim.g('GVL_IO')
        self.c = self.sim.g('GVL_Const')
        self.gvl = self.sim.g('GVL')
        self.hmi = self.sim.g('GVL_HMI')
        self.din, self.dout = [], []
        with open(os.path.join(ROOT, 'doc', 'IO_map.csv'), encoding='utf-8-sig') as f:
            for row in csv.DictReader(f, delimiter=';'):
                var, tgt = row['Переменная GVL_IO'], row['Логический сигнал']
                if not tgt:
                    continue
                for t in tgt.split(','):
                    pol = None
                    if '|' in t:
                        t, pol = t.split('|')
                    kind, rest = t.split(':')
                    (self.din if var.startswith('DI_') else self.dout).append((var, kind, rest, pol))
        self.outidx = {(k, r): var for var, k, r, _ in self.dout}
        self.mechs = sorted({r.split('.')[0] for _, k, r, _ in self.dout + self.din if k == 'M'})
        n = self.c['N_MECH']
        self.run = [False] * (n + 1)          # двигатель вращается
        self.gate = 0.0                       # 0 - закрыта, 1 - открыта
        self.fs_on = False
        self.valve = [0, 1, 1, 1, 1, 1]       # фактическое положение клапанов
        self.vmove = [0] * 6
        self.dks_ph = 0
        # отклонения, задаваемые сценарием: (kind, obj, field) -> логическое значение
        self.force = {}
        self.fail_run = set()                 # механизмы с обрывом (двигатель включен, но не крутится)
        self.t = 0

    def logic(self, kind, rest):
        obj, _, fld = rest.partition('.')
        key = (kind, obj, fld)
        if key in self.force:
            return self.force[key]
        if kind == 'G':
            return True
        if kind == 'B':
            return fld == 'xSF'
        i = self.c[obj]
        if kind == 'V':
            if fld == 'xSF':
                return True
            return self.valve[i] == (1 if fld == 'xS1' else 2)
        cfg = self.c['MECH_CFG'][i]
        running = self.run[i] and i not in self.fail_run
        return {
            'xQF': True, 'xDSL1': True, 'xDSL2': True, 'xDP': True, 'xLocal': False,
            'xLocStart': False, 'xLocStop': True, 'xEStop': True, 'xFcFault': False,
            'xFcReady': self.run[i],
            'xDKS': running and (self.dks_ph % 4 < 2 if cfg['eDks'] == 1 else True),
            'xFb1': self.gate >= 1.0 if cfg['eKind'] == 2 else self.fs_on,
            'xFb2': self.gate <= 0.0 if cfg['eKind'] == 2 else True,
            'xErr': False, 'xLocOpen': False, 'xLocClose': False,
        }[fld]

    def out(self, kind, name, fld):
        var = self.outidx.get((kind, f'{name}.{fld}'))
        return bool(var and self.io[var])

    def step(self, dt=20):
        self.dks_ph += 1
        for var, kind, rest, pol in self.din:
            v = self.logic(kind, rest)
            if pol:
                ref = self.c[POL[pol]]
                v = ref if v else (not ref)
            self.io[var] = v
        self.sim.scan(dt=dt)
        self.t += dt
        for nm in self.mechs:
            i = self.c[nm]
            kind = self.c['MECH_CFG'][i]['eKind']
            if kind == 0:
                self.run[i] = self.out('M', nm, 'qRun')
            elif kind == 1:
                self.run[i] = self.out('M', nm, 'qPower') and self.out('M', nm, 'qRun')
            elif kind == 2:
                if self.out('M', nm, 'qOpen'):
                    self.gate = min(1.0, self.gate + dt / 5000)
                if self.out('M', nm, 'qClose'):
                    self.gate = max(0.0, self.gate - dt / 5000)
            elif kind == 3:
                if self.out('M', nm, 'qOn'):
                    self.fs_on = True
                if self.out('M', nm, 'qOff'):
                    self.fs_on = False
                self.run[i] = self.fs_on
        for nm in ('V_V12_1', 'V_V12_2', 'V_V12_3', 'V_V12_4', 'V_V49'):
            i = self.c[nm]
            for p, f in ((1, 'q1'), (2, 'q2')):
                if self.out('V', nm, f):
                    self.valve[i] = 0
                    self.vmove[i] += dt
                    if self.vmove[i] >= 2000:
                        self.valve[i] = p
                        self.vmove[i] = 0
                    break
            else:
                self.vmove[i] = 0

    def run_for(self, ms, dt=100, until=None):
        end = self.t + ms
        while self.t < end:
            self.step(dt)
            if until and until():
                return True
        return False
