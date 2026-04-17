import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse

NS = {
    'main': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'rel': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
}


def load_first_sheet_rows(path: Path):
    with zipfile.ZipFile(path) as zf:
        shared = []
        if 'xl/sharedStrings.xml' in zf.namelist():
            root = ET.fromstring(zf.read('xl/sharedStrings.xml'))
            for si in root.findall('main:si', NS):
                texts = [t.text or '' for t in si.findall('.//main:t', NS)]
                shared.append(''.join(texts))

        workbook = ET.fromstring(zf.read('xl/workbook.xml'))
        sheets = workbook.find('main:sheets', NS)
        first_sheet = sheets[0]
        rel_id = first_sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']
        rels = ET.fromstring(zf.read('xl/_rels/workbook.xml.rels'))
        rel_map = {rel.attrib['Id']: rel.attrib['Target'] for rel in rels}
        target = rel_map[rel_id]
        if not target.startswith('xl/'):
            target = 'xl/' + target

        root = ET.fromstring(zf.read(target))
        rows = []
        for row in root.findall('.//main:sheetData/main:row', NS):
            values = {}
            for cell in row.findall('main:c', NS):
                ref = cell.attrib.get('r', '')
                col = ''.join(ch for ch in ref if ch.isalpha())
                t = cell.attrib.get('t')
                v = cell.find('main:v', NS)
                value = v.text if v is not None else ''
                if t == 's' and value:
                    value = shared[int(value)]
                values[col] = value
            rows.append(values)
        return rows


def slugify(value: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', value.lower()).strip('-')


def detect_source(company: str, url: str, official_url: str, row: dict):
    candidate = (url or official_url or '').strip()
    if not candidate.startswith('http'):
        return None

    parsed = urlparse(candidate)
    host = parsed.netloc.lower()
    path = parsed.path.strip('/')
    parts = [p for p in path.split('/') if p]
    key_base = slugify(company)

    if 'greenhouse.io' in host:
        token = parts[0] if parts else ''
        if host.startswith('boards.greenhouse.io') and token:
            return {
                'key': f'{key_base}-greenhouse',
                'company': company,
                'provider': 'greenhouse',
                'boardToken': token,
            }

    if 'lever.co' in host:
        site = parts[0] if parts else ''
        if host.startswith('jobs.lever.co') and site:
            return {
                'key': f'{key_base}-lever',
                'company': company,
                'provider': 'lever',
                'site': site,
            }

    if 'ashbyhq.com' in host:
        org = parts[0] if parts else ''
        if org:
            return {
                'key': f'{key_base}-ashby',
                'company': company,
                'provider': 'ashby',
                'organization': org,
            }

    if 'smartrecruiters.com' in host:
        identifier = parts[-1] if parts else ''
        if identifier:
            return {
                'key': f'{key_base}-smartrecruiters',
                'company': company,
                'provider': 'smartrecruiters',
                'companyIdentifier': identifier,
            }

    if host.endswith('.workable.com'):
        subdomain = host.split('.')[0]
        return {
            'key': f'{key_base}-workable',
            'company': company,
            'provider': 'workable',
            'subdomain': subdomain,
        }

    if host.endswith('.recruitee.com'):
        subdomain = host.split('.')[0]
        return {
            'key': f'{key_base}-recruitee',
            'company': company,
            'provider': 'recruitee',
            'subdomain': subdomain,
        }

    if 'jobvite.com' in host:
        site = parts[0] if parts else ''
        if site and site not in {'jobs', 'careersite', 'careers'}:
            return {
                'key': f'{key_base}-jobvite',
                'company': company,
                'provider': 'jobvite',
                'site': site,
            }
        return {
            'key': f'{key_base}-jobvite',
            'company': company,
            'provider': 'jobvite',
            'careersUrl': candidate,
        }

    if 'applytojob.com' in host:
        return {
            'key': f'{key_base}-applytojob',
            'company': company,
            'provider': 'applytojob',
            'careersUrl': candidate,
        }

    if 'applicantpro.com' in host:
        return {
            'key': f'{key_base}-applicantpro',
            'company': company,
            'provider': 'applicantpro',
            'careersUrl': candidate,
        }

    if 'taleo.net' in host or 'oraclecloud.com' in host and 'careersection' in candidate.lower():
        return {
            'key': f'{key_base}-taleo',
            'company': company,
            'provider': 'taleo',
            'careersUrl': candidate,
        }

    if 'ultipro.com' in host or 'ukg.com' in host or 'myworkdayjobs.com' in host:
        return {
            'key': f'{key_base}-careerpage',
            'company': company,
            'provider': 'careerpage',
            'careersUrl': candidate,
        }

    if 'icims.com' in host:
        return {
            'key': f'{key_base}-careerpage',
            'company': company,
            'provider': 'careerpage',
            'careersUrl': candidate,
        }

    return {
        'key': f'{key_base}-careerpage',
        'company': company,
        'provider': 'careerpage',
        'careersUrl': candidate,
    }


def main():
    if len(sys.argv) < 2:
        print('Usage: python scripts/import_sources_from_xlsx.py <xlsx-path> [config-path]')
        raise SystemExit(1)

    xlsx_path = Path(sys.argv[1])
    config_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path('config/sources.json')

    rows = load_first_sheet_rows(xlsx_path)
    data_rows = [row for row in rows if row.get('C') and row.get('C') != 'Company']

    imported = []
    for row in data_rows:
        company = (row.get('C') or '').strip()
        official = (row.get('E') or '').strip()
        verified = (row.get('F') or '').strip()
        source = detect_source(company, verified, official, row)
        if source:
            source['importedFrom'] = xlsx_path.name
            imported.append(source)

    existing = []
    if config_path.exists():
        existing = json.loads(config_path.read_text(encoding='utf-8')).get('sources', [])

    merged = {item['key']: item for item in existing}
    for item in imported:
        merged[item['key']] = item

    result = {'sources': list(merged.values())}
    config_path.write_text(json.dumps(result, indent=2), encoding='utf-8')

    counts = {}
    for item in imported:
        counts[item['provider']] = counts.get(item['provider'], 0) + 1

    print(f'Imported {len(imported)} sources from {xlsx_path.name}')
    print(json.dumps(counts, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
