"""Минимальный интерпретатор IEC 61131-3 ST (подмножество, используемое в проекте)
для проверки логики без контроллера. Разбор - библиотека blark.

Поддерживается: TYPE STRUCT, VAR_GLOBAL (включая CONSTANT/RETAIN/AT), FUNCTION,
FUNCTION_BLOCK, PROGRAM, IF/CASE/FOR/EXIT, массивы (многомерные), структуры,
VAR_IN_OUT по ссылке, TON/TOF/TP/R_TRIG/F_TRIG, MIN/MAX/SHL, преобразования *_TO_*.
"""
import copy
import glob
import os
import re

from blark import transform as tf
from blark.parse import parse_source_code


class Word(int):
    """16-битное беззнаковое (WORD) - нужно для NOT"""
    def __new__(cls, v):
        return int.__new__(cls, int(v) & 0xFFFF)


class Struct:
    def __init__(self, tname, fields):
        object.__setattr__(self, '_t', tname)
        object.__setattr__(self, '_f', fields)

    def __getitem__(self, k):
        return self._f[k]

    def __setitem__(self, k, v):
        if k not in self._f:
            raise KeyError(f'{self._t} has no field {k}')
        self._f[k] = coerce(self._f[k], v)

    def __contains__(self, k):
        return k in self._f

    def __deepcopy__(self, memo):
        return Struct(self._t, {k: copy.deepcopy(v, memo) for k, v in self._f.items()})

    def __repr__(self):
        return f'{self._t}({self._f})'


class Arr:
    def __init__(self, dims, items):
        self.dims = dims            # [(lo, hi), ...]
        self.items = items          # dict key(tuple) -> value

    def _key(self, k):
        k = k if isinstance(k, tuple) else (k,)
        if len(k) != len(self.dims):
            raise IndexError('bad dims')
        for x, (lo, hi) in zip(k, self.dims):
            if not lo <= x <= hi:
                raise IndexError(f'index {x} out of [{lo}..{hi}]')
        return k

    def __getitem__(self, k):
        return self.items[self._key(k)]

    def __setitem__(self, k, v):
        kk = self._key(k)
        self.items[kk] = coerce(self.items[kk], v)

    def __deepcopy__(self, memo):
        return Arr(list(self.dims), {k: copy.deepcopy(v, memo) for k, v in self.items.items()})


def coerce(old, new):
    if isinstance(old, Word):
        return Word(new)
    if isinstance(old, bool):
        if not isinstance(new, bool):
            raise TypeError(f'assign {new!r} to BOOL')
        return new
    if isinstance(old, int):
        if isinstance(new, bool):
            raise TypeError(f'assign BOOL to integer')
        return int(new)
    if isinstance(old, (Struct, Arr)):
        if type(old) is not type(new):
            raise TypeError(f'assign {type(new)} to {type(old)}')
        return copy.deepcopy(new)
    if isinstance(old, FBInst):
        raise TypeError('assign to FB instance')
    return new


class Ref:
    def __init__(self, cont, key):
        self.cont, self.key = cont, key

    def get(self):
        return self.cont[self.key]

    def set(self, v):
        self.cont[self.key] = v


class STError(Exception):
    pass


class ExitLoop(Exception):
    pass


ELEM = {'BOOL': False, 'INT': 0, 'UINT': 0, 'UDINT': 0, 'DINT': 0, 'SINT': 0, 'USINT': 0, 'BYTE': 0,
        'WORD': None, 'DWORD': 0, 'TIME': 0, 'REAL': 0.0, 'LREAL': 0.0}
INT_MASK = {'UINT': 0xFFFF, 'UDINT': 0xFFFFFFFF, 'USINT': 0xFF, 'BYTE': 0xFF, 'DWORD': 0xFFFFFFFF}


class Scope:
    """Переменные экземпляра/кадра: dict имя -> значение или Ref (для IN_OUT)"""
    def __init__(self):
        self.v = {}

    def __contains__(self, k):
        return k in self.v

    def __getitem__(self, k):
        x = self.v[k]
        return x.get() if isinstance(x, Ref) else x

    def __setitem__(self, k, val):
        x = self.v[k]
        if isinstance(x, Ref):
            x.set(val)
        else:
            self.v[k] = coerce(x, val)


class FBInst(Scope):
    def __init__(self, pou):
        super().__init__()
        self.pou = pou


class StdFB(Scope):
    kind = None

    def __init__(self, sim):
        super().__init__()
        self.sim = sim


class TON(StdFB):
    def __init__(self, sim):
        super().__init__(sim)
        self.v = {'IN': False, 'PT': 0, 'Q': False, 'ET': 0}
        self.t0 = None

    def run(self):
        if self.v['IN']:
            if self.t0 is None:
                self.t0 = self.sim.now
            self.v['ET'] = min(self.sim.now - self.t0, self.v['PT'])
            self.v['Q'] = self.sim.now - self.t0 >= self.v['PT']
        else:
            self.t0 = None
            self.v['ET'] = 0
            self.v['Q'] = False


class TOF(StdFB):
    def __init__(self, sim):
        super().__init__(sim)
        self.v = {'IN': False, 'PT': 0, 'Q': False, 'ET': 0}
        self.t0 = None

    def run(self):
        if self.v['IN']:
            self.t0 = None
            self.v['Q'] = True
            self.v['ET'] = 0
        else:
            if self.v['Q'] and self.t0 is None:
                self.t0 = self.sim.now
            if self.t0 is not None:
                self.v['ET'] = min(self.sim.now - self.t0, self.v['PT'])
                if self.sim.now - self.t0 >= self.v['PT']:
                    self.v['Q'] = False


class TP(StdFB):
    def __init__(self, sim):
        super().__init__(sim)
        self.v = {'IN': False, 'PT': 0, 'Q': False, 'ET': 0}
        self.t0 = None
        self.prev = False

    def run(self):
        if self.v['IN'] and not self.prev and self.t0 is None:
            self.t0 = self.sim.now
        self.prev = self.v['IN']
        if self.t0 is not None:
            if self.sim.now - self.t0 < self.v['PT']:
                self.v['Q'] = True
            else:
                self.v['Q'] = False
                if not self.v['IN']:
                    self.t0 = None


class R_TRIG(StdFB):
    def __init__(self, sim):
        super().__init__(sim)
        self.v = {'CLK': False, 'Q': False}
        self.m = False

    def run(self):
        self.v['Q'] = self.v['CLK'] and not self.m
        self.m = self.v['CLK']


class F_TRIG(StdFB):
    def __init__(self, sim):
        super().__init__(sim)
        self.v = {'CLK': False, 'Q': False}
        self.m = False

    def run(self):
        self.v['Q'] = (not self.v['CLK']) and self.m
        self.m = self.v['CLK']


STD_FB = {'TON': TON, 'TOF': TOF, 'TP': TP, 'R_TRIG': R_TRIG, 'F_TRIG': F_TRIG}


class Pou:
    def __init__(self, kind, node):
        self.kind = kind          # 'fb' | 'fun' | 'prg'
        self.node = node
        self.name = str(node.name)
        self.decls = []           # (section, name, typespec, initnode)


def _cls(x):
    return type(x).__name__


class Sim:
    def __init__(self, src_dir):
        self.now = 0
        self.types = {}      # имя STRUCT -> [(поле, typespec, init)]
        self.pous = {}
        self.gvls = {}       # имя GVL -> Scope
        self.prg_inst = {}
        files = sorted(glob.glob(os.path.join(src_dir, 'DUT', '*.st'))) + \
            sorted(glob.glob(os.path.join(src_dir, 'POU', '*.st')))
        gvl_files = sorted(glob.glob(os.path.join(src_dir, 'GVL', '*.st')),
                           key=lambda f: (0 if f.endswith('GVL_Const.st') else 1, f))
        for f in files:
            self._load(f)
        for f in gvl_files:
            name = os.path.splitext(os.path.basename(f))[0]
            self._load_gvl(f, name)

    # ---------- загрузка ----------
    def _parse(self, path):
        import hashlib
        import pickle
        text = open(path, encoding='utf-8').read()
        cache = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache')
        os.makedirs(cache, exist_ok=True)
        key = os.path.join(cache, hashlib.sha1(text.encode()).hexdigest() + '.pkl')
        if os.path.exists(key):
            with open(key, 'rb') as f:
                return pickle.load(f)
        res = parse_source_code(text, fn=path)
        tr = res.transform() if hasattr(res, 'transform') else res
        try:
            with open(key, 'wb') as f:
                pickle.dump(tr, f)
        except Exception:
            os.remove(key)
        return tr

    def _load(self, path):
        sc = self._parse(path)
        for it in sc.items:
            c = _cls(it)
            if c == 'DataTypeDeclaration':
                d = it.declaration
                fields = []
                for el in d.declarations:
                    for vn in el.variables:
                        fields.append((str(vn), el.init))
                self.types[str(d.name)] = fields
            elif c in ('FunctionBlock', 'Function', 'Program'):
                p = Pou({'FunctionBlock': 'fb', 'Function': 'fun', 'Program': 'prg'}[c], it)
                for blk in it.declarations:
                    sec = {'InputDeclarations': 'in', 'OutputDeclarations': 'out',
                           'InputOutputDeclarations': 'inout'}.get(_cls(blk), 'var')
                    for item in blk.items:
                        for vn in item.variables:
                            nm = str(vn.name) if hasattr(vn, 'name') else str(vn)
                            nm = str(getattr(vn, 'variable', nm))
                            p.decls.append((sec, nm, item))
                self.pous[p.name] = p
            else:
                raise NotImplementedError(c)

    def _load_gvl(self, path, name):
        sc = self._parse(path)
        g = Scope()
        self.gvls[name] = g
        for it in sc.items:
            for item in it.items:
                spec = item.spec
                for vn in spec.variables:
                    nm = str(getattr(vn, 'variable', vn))
                    g.v[nm] = self.make_value(item.init, None)

    # ---------- типы и значения ----------
    def type_parts(self, init):
        """-> ('elem', NAME) | ('array', dims, elemspec_text) | ('named', NAME), значение-инициализатор"""
        c = _cls(init)
        if c in ('ArrayTypeInitialization',):
            spec = init.spec
            dims = [(self.eval(s.start, None), self.eval(s.stop, None)) for s in spec.subranges]
            return ('array', dims, str(spec.type)), init.value
        if c == 'TypeInitialization':
            return ('named', str(init.spec).strip()), init.value
        if c in ('StructureInitialization', 'InitializedStructure'):
            return ('named', str(init.name).strip()), getattr(init, 'init', None)
        if hasattr(init, 'spec') and _cls(init.spec) == 'ArraySpecification':
            spec = init.spec
            dims = [(self.eval(s.start, None), self.eval(s.stop, None)) for s in spec.subranges]
            return ('array', dims, str(spec.type)), getattr(init, 'value', None)
        if hasattr(init, 'spec'):
            return ('named', str(init.spec).strip()), getattr(init, 'value', None)
        # FunctionBlockNameDeclaration / прочее: попробовать текст
        txt = str(init).strip()
        return ('named', txt), None

    def default_of(self, tname):
        tname = tname.strip()
        m = re.match(r'^STRING(\(\d+\))?$', tname)
        if m:
            return ''
        if tname in ELEM:
            return Word(0) if tname == 'WORD' else ELEM[tname]
        if tname in STD_FB:
            return STD_FB[tname](self)
        if tname in self.pous and self.pous[tname].kind == 'fb':
            return self.new_fb(self.pous[tname])
        if tname in self.types:
            f = {}
            for fname, finit in self.types[tname]:
                f[fname] = self.make_value(finit, None)
            return Struct(tname, f)
        m = re.match(r'^ARRAY\s*\[(.*?)\]\s*OF\s+(.*)$', tname, re.S)
        if m:
            raise NotImplementedError('inline array type text ' + tname)
        raise KeyError('unknown type ' + tname)

    def make_value(self, init, scope):
        (kind, *rest), ival = self.type_parts(init)
        if kind == 'array':
            dims, etype = rest
            import itertools
            keys = list(itertools.product(*[range(lo, hi + 1) for lo, hi in dims]))
            items = {k: self.default_of(etype) for k in keys}
            arr = Arr(dims, items)
            if ival is not None and etype.strip() in self.types:
                # blark неоднозначно разбирает [(a := 1, ...), ...] - разбираем текст сами
                groups = re.findall(r'\(([^()]*)\)', str(ival))
                if len(groups) != len(keys):
                    raise ValueError(f'struct array init count {len(groups)} != {len(keys)}')
                for k, grp in zip(keys, groups):
                    for pair in grp.split(','):
                        fname, _, fval = pair.partition(':=')
                        fval = fval.strip()
                        if fval.upper() in ('TRUE', 'FALSE'):
                            val = fval.upper() == 'TRUE'
                        else:
                            val = int(fval)
                        arr.items[k][fname.strip()] = val
            elif ival is not None:
                flat = []

                def flatten(ai):
                    for el in ai.elements:
                        cnt = self.eval(el.count, scope) if getattr(el, 'count', None) is not None else 1
                        for _ in range(cnt):
                            if _cls(el.element) == 'ArrayInitialization':
                                flatten(el.element)
                            else:
                                flat.append(el.element)
                flatten(ival)
                if len(flat) > len(keys):
                    raise ValueError('too many array initializers')
                if len(flat) not in (1, len(keys)):
                    raise ValueError(f'array initializer count {len(flat)} != {len(keys)}')
                for k, e in zip(keys, flat):
                    arr.items[k] = self.init_elem(arr.items[k], e, scope)
            return arr
        tname = rest[0]
        v = self.default_of(tname)
        if ival is not None:
            v = self.init_elem(v, ival, scope)
        return v

    def init_elem(self, cur, e, scope):
        if _cls(e) == 'StructureInitialization':
            for se in e.elements:
                cur[str(se.name)] = self.init_elem(cur[str(se.name)], se.value, scope)
            return cur
        if _cls(e) == 'ArrayInitialization':
            if len(e.elements) == 1 and getattr(e.elements[0], 'count', None) is None:
                return self.init_elem(cur, e.elements[0].element, scope)
            raise NotImplementedError('nested array init')
        return coerce(cur, self.eval(e, scope))

    def new_fb(self, pou):
        inst = FBInst(pou)
        for sec, nm, item in pou.decls:
            if sec == 'inout':
                inst.v[nm] = None
            else:
                inst.v[nm] = self.make_value(item.init, inst)
        return inst

    # ---------- имена ----------
    def lookup_container(self, name, scope):
        if scope is not None and name in scope:
            return scope
        if name in self.gvls:
            return None  # пространство имён
        for g in self.gvls.values():
            if name in g:
                return g
        raise NameError(name)

    def lvalue(self, node, scope):
        """-> (контейнер, ключ)"""
        c = _cls(node)
        if c == 'SimpleVariable':
            nm = str(node.name)
            cont = self.lookup_container(nm, scope)
            if cont is None:
                raise NameError('namespace used as value: ' + nm)
            return cont, nm
        if c == 'MultiElementVariable':
            nm = str(node.name)
            cont = self.lookup_container(nm, scope)
            if cont is None:
                cont, key = self.gvls[nm], None
            else:
                key = nm
            for el in node.elements:
                if key is not None:
                    cont = cont[key]
                if _cls(el) == 'FieldSelector':
                    fld = str(el.field)
                    if isinstance(cont, Scope) and fld not in cont:
                        raise NameError(f'no field {fld}')
                    key = fld
                elif _cls(el) == 'SubscriptList':
                    idx = tuple(self.eval(s, scope) for s in el.subscripts)
                    key = idx if len(idx) > 1 else idx[0]
                else:
                    raise NotImplementedError(_cls(el))
            return cont, key
        raise NotImplementedError('lvalue ' + c)

    # ---------- выражения ----------
    def eval(self, n, scope):
        c = _cls(n)
        if c in ('SimpleVariable', 'MultiElementVariable'):
            cont, key = self.lvalue(n, scope)
            return cont[key]
        if c == 'Integer':
            v = int(str(n.value).replace('_', ''), int(n.base) if n.base else 10)
            return Word(v) if str(n.type_name or '') == 'WORD' else v
        if c in ('HexInteger', 'BinaryInteger', 'OctalInteger'):
            v = int(str(n.value).replace('_', ''), int(n.base))
            return Word(v) if str(n.type_name or '') == 'WORD' else v
        if c in ('BitString', 'HexBitString', 'BinaryBitString', 'OctalBitString'):
            v = int(str(n.value).replace('_', ''), int(n.base) if n.base else 10)
            return Word(v) if str(n.type_name or '') == 'WORD' else v
        if c == 'Boolean':
            return str(n.value).upper() in ('TRUE', '1')
        if c == 'Duration':
            ms = 0.0
            for f, k in (('days', 86400000), ('hours', 3600000), ('minutes', 60000), ('seconds', 1000),
                         ('milliseconds', 1)):
                x = getattr(n, f)
                if x is not None:
                    ms += float(x) * k
            return int(ms)
        if c == 'ParenthesizedExpression':
            return self.eval(n.expr, scope)
        if c == 'EnumeratedValue':
            # метка CASE вида GVL_Const.K_FC
            full = (str(n.type_name) + '.' if n.type_name else '') + str(n.name)
            parts = full.split('.')
            if len(parts) == 1:
                return self.lookup_container(parts[0], scope)[parts[0]]
            ns, nm = '.'.join(parts[:-1]), parts[-1]
            if ns in self.gvls:
                return self.gvls[ns][nm]
            raise NameError(f'{ns}.{nm}')
        if c == 'UnaryOperation':
            v = self.eval(n.expr, scope)
            op = str(n.op).upper()
            if op == 'NOT':
                if isinstance(v, bool):
                    return not v
                if isinstance(v, Word):
                    return Word(~v)
                raise TypeError('NOT on ' + repr(v))
            if op == '-':
                return -v
            raise NotImplementedError(op)
        if c == 'BinaryOperation':
            op = str(n.op).upper()
            a = self.eval(n.left, scope)
            b = self.eval(n.right, scope)
            if op in ('AND', 'OR', 'XOR', 'AND_THEN', 'OR_ELSE'):
                if isinstance(a, bool) != isinstance(b, bool):
                    raise TypeError(f'{op} mixes BOOL and integer: {a!r} {b!r} @ {n}')
                if isinstance(a, bool):
                    return {'AND': a and b, 'AND_THEN': a and b, 'OR': a or b, 'OR_ELSE': a or b,
                            'XOR': a != b}[op]
                r = {'AND': a & b, 'OR': a | b, 'XOR': a ^ b}[op]
                return Word(r) if isinstance(a, Word) or isinstance(b, Word) else r
            if op in ('=', '<>', '<', '>', '<=', '>='):
                if isinstance(a, bool) != isinstance(b, bool):
                    raise TypeError(f'compare BOOL with integer @ {n}')
                return {'=': a == b, '<>': a != b, '<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b}[op]
            if isinstance(a, bool) or isinstance(b, bool):
                raise TypeError(f'arithmetic on BOOL @ {n}')
            if op == '+':
                return a + b
            if op == '-':
                return a - b
            if op == '*':
                return a * b
            if op == '/':
                return int(a / b)
            if op == 'MOD':
                return a % b
            raise NotImplementedError(op)
        if c == 'FunctionCall':
            return self.call(n, scope, expr=True)
        raise NotImplementedError('expr ' + c + ' ' + str(n))

    # ---------- вызовы ----------
    def builtin(self, name, args):
        u = name.upper()
        if u == 'MIN':
            return min(args)
        if u == 'MAX':
            return max(args)
        if u == 'SHL':
            r = args[0] << args[1]
            return Word(r) if isinstance(args[0], Word) else r
        m = re.match(r'^([A-Z]+)_TO_([A-Z]+)$', u)
        if m:
            src, dst = m.groups()
            v = args[0]
            if dst == 'WORD':
                return Word(v)
            if dst == 'BOOL':
                return v != 0
            if isinstance(v, bool):
                v = int(v)
            if dst in INT_MASK:
                return int(v) & INT_MASK[dst]
            return int(v)
        return None

    def call(self, n, scope, expr=False):
        nm_node = n.name
        params = n.parameters or []
        name = str(nm_node)
        if name in self.pous and self.pous[name].kind in ('fun', 'prg'):
            pou = self.pous[name]
            if pou.kind == 'prg':
                inst = self.prg_inst.get(name)
                if inst is None:
                    inst = self.prg_inst[name] = self.new_fb(pou)
                self.exec_list(pou.node.body, inst)
                return None
            frame = self.new_fb(pou)
            frame.v[name] = self.default_of(str(pou.node.return_type))
            self.bind(pou, frame, params, scope)
            self.exec_list(pou.node.body, frame)
            return frame.v[name]
        if _cls(nm_node) == 'SimpleVariable' and name not in (scope.v if scope else {}) and \
                not any(name in g for g in self.gvls.values()):
            args = [self.eval(p.value, scope) for p in params]
            r = self.builtin(name, args)
            if r is None:
                raise NameError('unknown function ' + name)
            return r
        cont, key = self.lvalue(nm_node, scope)
        inst = cont[key]
        if isinstance(inst, StdFB):
            for p in params:
                inst.v[str(p.name)] = coerce(inst.v[str(p.name)], self.eval(p.value, scope))
            inst.run()
            return None
        if isinstance(inst, FBInst):
            self.bind(inst.pou, inst, params, scope)
            self.exec_list(inst.pou.node.body, inst)
            for sec, pn, _ in inst.pou.decls:
                if sec == 'inout':
                    inst.v[pn] = None
            return None
        raise TypeError(f'not callable: {name}')

    def bind(self, pou, frame, params, scope):
        ins = [(s, nm) for s, nm, _ in pou.decls if s in ('in', 'inout')]
        for k, p in enumerate(params):
            if _cls(p) == 'OutputParameterAssignment':
                raise NotImplementedError('=> outputs')
            pname = str(p.name) if p.name is not None else ins[k][1]
            sec = next((s for s, nm, _ in pou.decls if nm == pname), None)
            if sec is None:
                raise NameError(f'{pou.name} has no parameter {pname}')
            if sec == 'inout':
                cont, key = self.lvalue(p.value, scope)
                frame.v[pname] = Ref(cont, key)
            elif sec == 'in':
                frame.v[pname] = coerce(frame.v[pname], self.eval(p.value, scope))
            else:
                raise NameError(f'cannot assign output {pname}')
        for sec, nm, _ in pou.decls:
            if sec == 'inout' and not isinstance(frame.v.get(nm), Ref):
                raise ValueError(f'{pou.name}: VAR_IN_OUT {nm} not bound')

    # ---------- операторы ----------
    def exec_list(self, sl, scope):
        if sl is None:
            return
        stmts = sl.statements if hasattr(sl, 'statements') else sl
        for s in stmts:
            self.exec(s, scope)

    def exec(self, s, scope):
        try:
            self._exec(s, scope)
        except (ExitLoop, STError):
            raise
        except Exception as e:
            m = getattr(s, 'meta', None)
            ln = getattr(m, 'line', '?') if m else '?'
            raise STError(f'{type(e).__name__}: {e}\n  at line {ln}: {str(s).splitlines()[0][:160]}') from e

    def _exec(self, s, scope):
        c = _cls(s)
        if c == 'AssignmentStatement':
            val = self.eval(s.expression, scope)
            for v in s.variables:
                cont, key = self.lvalue(v, scope)
                cont[key] = val
        elif c == 'IfStatement':
            if self.cond(s.if_expression, scope):
                self.exec_list(s.statements, scope)
                return
            for ei in s.else_ifs:
                if self.cond(ei.if_expression, scope):
                    self.exec_list(ei.statements, scope)
                    return
            if s.else_clause is not None:
                self.exec_list(s.else_clause.statements, scope)
        elif c == 'CaseStatement':
            v = self.eval(s.expression, scope)
            for ce in s.cases:
                for m in ce.matches:
                    if _cls(m) in ('PartialSubrange', 'Subrange'):
                        hit = self.eval(m.start, scope) <= v <= self.eval(m.stop, scope)
                    else:
                        hit = self.eval(m, scope) == v
                    if hit:
                        self.exec_list(ce.statements, scope)
                        return
            if s.else_clause is not None:
                self.exec_list(s.else_clause.statements, scope)
        elif c == 'ForStatement':
            cont, key = self.lvalue(s.control, scope)
            a = self.eval(s.from_, scope)
            b = self.eval(s.to, scope)
            step = self.eval(s.step, scope) if s.step is not None else 1
            cont[key] = a
            try:
                while (cont[key] <= b) if step > 0 else (cont[key] >= b):
                    self.exec_list(s.statements, scope)
                    cont[key] = cont[key] + step
            except ExitLoop:
                pass
        elif c == 'ExitStatement':
            raise ExitLoop()
        elif c == 'FunctionCallStatement':
            self.call(s, scope)
        elif c == 'NoOpStatement':
            pass
        elif c == 'StatementList':
            self.exec_list(s, scope)
        else:
            raise NotImplementedError('stmt ' + c)

    def cond(self, e, scope):
        v = self.eval(e, scope)
        if not isinstance(v, bool):
            raise TypeError(f'condition is not BOOL: {e}')
        return v

    # ---------- цикл ----------
    def scan(self, prg='PLC_PRG', dt=20):
        self.now += dt
        pou = self.pous[prg]
        inst = self.prg_inst.get(prg)
        if inst is None:
            inst = self.prg_inst[prg] = self.new_fb(pou)
        self.exec_list(pou.node.body, inst)

    def g(self, gvl):
        return self.gvls[gvl]
