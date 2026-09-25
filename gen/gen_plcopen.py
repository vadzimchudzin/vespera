#!/usr/bin/env python3
"""Собирает src/*.st в файл PLCopenXML для импорта в EcoStruxure Machine Expert
(Проект -> Импорт PLCopenXML). Формат - как у экспорта CODESYS V3: структурная часть по TC6 +
объявления текстом (InterfaceAsPlainText, при импорте имеют приоритет), ObjectId, папки."""
import datetime
import glob
import os
import re
import uuid

from lxml import etree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'machine_expert', 'EFBSH-649_PLC.xml')
NS = 'http://www.plcopen.org/xml/tc6_0200'
XHTML = 'http://www.w3.org/1999/xhtml'
S3 = 'http://www.3s-software.com/plcopenxml/'
ELEM = {'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD', 'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT',
        'ULINT', 'REAL', 'LREAL', 'TIME', 'DATE', 'TOD', 'DT'}
SECTIONS = {'VAR_INPUT': 'inputVars', 'VAR_OUTPUT': 'outputVars', 'VAR_IN_OUT': 'inOutVars',
            'VAR': 'localVars', 'VAR_TEMP': 'tempVars'}


def E(tag, attrib=None, *children, text=None):
    el = etree.Element(f'{{{NS}}}{tag}', {k: str(v) for k, v in (attrib or {}).items()})
    for c in children:
        if c is not None:
            el.append(c)
    if text is not None:
        el.text = text
    return el


def xhtml(text):
    el = etree.Element(f'{{{XHTML}}}xhtml', nsmap={None: XHTML})
    el.text = text
    return el


def oid(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'EFBSH-649/' + name))


def add_data(*items):
    ad = E('addData')
    for name, handle, child in items:
        d = E('data', {'name': S3 + name, 'handleUnknown': handle})
        d.append(child)
        ad.append(d)
    return ad


def plain(text):
    el = etree.Element('InterfaceAsPlainText')
    el.append(xhtml(text))
    return ('interfaceasplaintext', 'implementation', el)


def objid(name):
    el = etree.Element('ObjectId')
    el.text = oid(name)
    return ('objectid', 'discard', el)


def strip_comments(s):
    return re.sub(r'\(\*.*?\*\)', ' ', s, flags=re.S)


def split_top(s, sep):
    """разбить по sep вне скобок () []"""
    out, depth, cur = [], 0, ''
    for ch in s:
        if ch in '([':
            depth += 1
        elif ch in ')]':
            depth -= 1
        if ch == sep and depth == 0:
            out.append(cur)
            cur = ''
        else:
            cur += ch
    if cur.strip():
        out.append(cur)
    return out


# ---------- типы ----------
def type_el(t):
    t = ' '.join(t.split())
    m = re.match(r'^ARRAY\s*\[(.*?)\]\s*OF\s+(.+)$', t, re.I)
    if m:
        arr = E('array')
        for dim in split_top(m.group(1), ','):
            lo, hi = [x.strip() for x in dim.split('..')]
            arr.append(E('dimension', {'lower': lo, 'upper': hi}))
        arr.append(E('baseType', None, type_el(m.group(2))))
        return arr
    if t.upper() in ELEM:
        return E(t.upper())
    return E('derived', {'name': t})


# ---------- начальные значения ----------
def value_el(v):
    v = v.strip()
    if v.startswith('['):
        av = E('arrayValue')
        for item in split_top(v[1:-1], ','):
            item = item.strip()
            rep = None
            m = re.match(r'^(\d+)\s*\((.*)\)$', item, re.S)
            if m:
                rep, item = m.group(1), m.group(2)
            val = E('value', {'repetitionValue': rep} if rep else None)
            val.append(value_el(item))
            av.append(val)
        return av
    if v.startswith('(') and ':=' in v:
        sv = E('structValue')
        for pair in split_top(v[1:-1], ','):
            member, _, x = pair.partition(':=')
            val = E('value', {'member': member.strip()})
            val.append(value_el(x))
            sv.append(val)
        return sv
    return E('simpleValue', {'value': ' '.join(v.split())})


def variables(decl_text):
    """-> [(имя, адрес|None, тип, инициализация|None)] из текста между VAR... и END_VAR"""
    res = []
    for d in split_top(strip_comments(decl_text), ';'):
        d = d.strip()
        if not d:
            continue
        m = re.match(r'^([\w\s,]+?)(?:\s+AT\s+(%\S+))?\s*:\s*(.+)$', d, re.S)
        if not m:
            raise ValueError('не разобрано объявление: ' + d)
        names, addr, rest = m.groups()
        typ, _, init = rest.partition(':=')
        for nm in names.split(','):
            res.append((nm.strip(), addr, typ.strip(), init.strip() or None))
    return res


def var_el(name, addr, typ, init):
    v = E('variable', {'name': name, **({'address': addr} if addr else {})})
    v.append(E('type', None, type_el(typ)))
    if init:
        v.append(E('initialValue', None, value_el(init)))
    return v


def var_blocks(text):
    """-> [(ключевое слово, модификатор, тело)]"""
    t = strip_comments(text)
    return [(m.group(1).upper(), (m.group(2) or '').upper(), m.group(3)) for m in
            re.finditer(r'\b(VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|VAR)\b'
                        r'(?:[ \t]+(CONSTANT|RETAIN|PERSISTENT))?(.*?)\bEND_VAR\b', t, re.S)]


# ---------- объекты ----------
def build_dut(name, text):
    body = re.search(r'\bSTRUCT\b(.*?)\bEND_STRUCT\b', strip_comments(text), re.S).group(1)
    st = E('struct')
    for v in variables(body):
        st.append(var_el(*v))
    return E('dataType', {'name': name}, E('baseType', None, st), add_data(plain(text), objid(name)))


def build_pou(name, text):
    m = re.search(r'^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+(\w+)(?:\s*:\s*(\w+))?', text, re.M)
    kind, pname, ret = m.groups()
    assert pname == name, (pname, name)
    # объявление - до последнего END_VAR (в теле END_VAR не встречается)
    n_end = len(re.findall(r'\bEND_VAR\b', strip_comments(text)))
    pos = m.end()
    if n_end:
        it = [x for x in re.finditer(r'^\s*END_VAR\b.*$', text, re.M)]
        assert len(it) == n_end, name
        pos = it[-1].end()
    decl = text[:pos].rstrip() + '\n'
    tail = text[pos:]
    endm = list(re.finditer(r'^\s*END_(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s*$', tail, re.M))[-1]
    body = tail[:endm.start()].strip('\n') + '\n'

    itf = E('interface')
    if ret:
        itf.append(E('returnType', None, type_el(ret)))
    for kw, mod, btxt in var_blocks(decl):
        attrs = {'constant': 'true'} if mod == 'CONSTANT' else {}
        vl = E(SECTIONS[kw], attrs)
        for v in variables(btxt):
            vl.append(var_el(*v))
        itf.append(vl)
    pou_type = {'PROGRAM': 'program', 'FUNCTION_BLOCK': 'functionBlock', 'FUNCTION': 'function'}[kind]
    b = E('body', None, E('ST', None, xhtml(body)))
    return E('pou', {'name': name, 'pouType': pou_type}, itf, b, add_data(plain(decl), objid(name))), decl, body


def build_gvl(name, text):
    blocks = var_blocks(text)
    assert len(blocks) == 1 and blocks[0][0] == 'VAR_GLOBAL', name
    _, mod, btxt = blocks[0]
    attrs = {'name': name}
    if mod == 'CONSTANT':
        attrs['constant'] = 'true'
    if mod == 'RETAIN':
        attrs['retain'] = 'true'
    gv = E('globalVars', attrs)
    for v in variables(btxt):
        gv.append(var_el(*v))
    gv.append(add_data(plain(text), objid(name)))
    return gv


def main():
    now = datetime.datetime.now().replace(microsecond=0).isoformat()
    proj = etree.Element(f'{{{NS}}}project', nsmap={None: NS})
    proj.append(E('fileHeader', {'companyName': 'ЗАО "Борисовский завод Металлист"',
                                 'productName': 'CODESYS', 'productVersion': 'CODESYS V3.5',
                                 'creationDateTime': now}))
    coord = E('coordinateInfo', None,
              *[E(k, None, E('scaling', {'x': 1, 'y': 1})) for k in ('fbd', 'ld', 'sfc')])
    pi = etree.Element('ProjectInformation')
    proj.append(E('contentHeader', {'name': 'EFBSH-649_PLC', 'modificationDateTime': now}, coord,
                  add_data(('projectinformation', 'implementation', pi))))
    dts, pous = E('dataTypes'), E('pous')
    proj.append(E('types', None, dts, pous))
    proj.append(E('instances', None, E('configurations')))

    struct = etree.Element('ProjectStructure')
    folders = {}
    for f in ('DUT', 'GVL', 'POU'):
        folders[f] = etree.SubElement(struct, 'Folder', Name=f)
    gvls = etree.Element('globalVarsHolder')
    stats = {}
    for path in sorted(glob.glob(os.path.join(ROOT, 'src', '*', '*.st'))):
        folder = os.path.basename(os.path.dirname(path))
        name = os.path.splitext(os.path.basename(path))[0]
        text = open(path, encoding='utf-8').read().replace('\r\n', '\n')
        if folder == 'DUT':
            dts.append(build_dut(name, text))
        elif folder == 'GVL':
            gvls.append(build_gvl(name, text))
        else:
            pous.append(build_pou(name, text)[0])
        etree.SubElement(folders[folder], 'Object', Name=name, ObjectId=oid(name))
        stats[folder] = stats.get(folder, 0) + 1

    top = E('addData')
    for g in list(gvls):
        gdata = E('data', {'name': S3 + 'globalvars', 'handleUnknown': 'implementation'})
        gdata.append(g)
        top.append(gdata)
    sdata = E('data', {'name': S3 + 'projectstructure', 'handleUnknown': 'discard'})
    sdata.append(struct)
    top.append(sdata)
    proj.append(top)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    etree.ElementTree(proj).write(OUT, encoding='utf-8', xml_declaration=True, pretty_print=True)
    print(os.path.relpath(OUT, ROOT), stats)


if __name__ == '__main__':
    main()
