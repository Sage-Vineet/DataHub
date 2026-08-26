import sys, zipfile, re, os
import xml.etree.ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'

def para_text(p):
    parts = []
    for node in p.iter():
        if node.tag == W+'t':
            parts.append(node.text or '')
        elif node.tag == W+'tab':
            parts.append('\t')
        elif node.tag == W+'br':
            parts.append('\n')
    return ''.join(parts)

def docx_to_text(path):
    z = zipfile.ZipFile(path)
    root = ET.fromstring(z.read('word/document.xml'))
    body = root.find(W+'body')
    out = []
    def walk(el):
        for child in el:
            if child.tag == W+'p':
                style = ''
                pPr = child.find(W+'pPr')
                if pPr is not None:
                    ps = pPr.find(W+'pStyle')
                    if ps is not None:
                        style = ps.get(W+'val') or ''
                t = para_text(child)
                if t.strip():
                    if style.startswith('Heading'):
                        lvl = re.sub(r'\D', '', style) or '1'
                        out.append('#'*min(int(lvl),6) + ' ' + t.strip())
                    elif style in ('Title',):
                        out.append('# ' + t.strip())
                    elif 'ListParagraph' in style:
                        out.append('- ' + t.strip())
                    else:
                        out.append(t.strip())
            elif child.tag == W+'tbl':
                rows = []
                for tr in child.findall(W+'tr'):
                    cells = []
                    for tc in tr.findall(W+'tc'):
                        ct = ' '.join(para_text(p).strip() for p in tc.findall(W+'p'))
                        cells.append(re.sub(r'\s+', ' ', ct).strip())
                    rows.append(cells)
                if rows:
                    out.append('')
                    for i, r in enumerate(rows):
                        out.append('| ' + ' | '.join(r) + ' |')
                        if i == 0:
                            out.append('|' + '---|'*len(r))
                    out.append('')
            else:
                walk(child)
    walk(body)
    return '\n'.join(out)

def col_to_idx(ref):
    m = re.match(r'([A-Z]+)', ref)
    n = 0
    for ch in m.group(1):
        n = n*26 + (ord(ch)-64)
    return n-1

def xlsx_to_text(path):
    z = zipfile.ZipFile(path)
    S = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        sroot = ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in sroot.findall(S+'si'):
            shared.append(''.join(t.text or '' for t in si.iter(S+'t')))
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    names = [s.get('name') for s in wb.iter(S+'sheet')]
    out = []
    sheets = sorted([n for n in z.namelist() if re.match(r'xl/worksheets/sheet\d+\.xml$', n)],
                    key=lambda n: int(re.search(r'(\d+)', n).group(1)))
    for idx, sname in enumerate(sheets):
        out.append('\n\n===== SHEET: %s =====' % (names[idx] if idx < len(names) else sname))
        root = ET.fromstring(z.read(sname))
        for row in root.iter(S+'row'):
            cells = {}
            for c in row.findall(S+'c'):
                ref = c.get('r') or 'A1'
                ci = col_to_idx(ref)
                t = c.get('t')
                v = c.find(S+'v')
                isel = c.find(S+'is')
                if t == 's' and v is not None:
                    val = shared[int(v.text)]
                elif isel is not None:
                    val = ''.join(x.text or '' for x in isel.iter(S+'t'))
                elif v is not None:
                    val = v.text or ''
                else:
                    val = ''
                if val.strip():
                    cells[ci] = re.sub(r'\s+', ' ', val).strip()
            if cells:
                mx = max(cells)
                out.append(' | '.join(cells.get(i, '') for i in range(mx+1)))
    return '\n'.join(out)

p = sys.argv[1]
print(xlsx_to_text(p) if p.endswith('.xlsx') else docx_to_text(p))
