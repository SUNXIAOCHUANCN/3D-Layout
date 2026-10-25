"""Rename workflow bundle directories to original model names and rewrite scene refs.

No bundle file is edited: asset IDs, internal GLB names, geometry and tags stay intact.
Default is dry run. --apply performs the rename with scene/index backups and rollback.
"""
from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import unicodedata

ROOT = Path(__file__).resolve().parents[2]


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inventory(directory):
    return {p.relative_to(directory).as_posix(): digest(p.read_bytes())
            for p in sorted(directory.rglob('*')) if p.is_file()}


def atomic_write(path, data):
    temporary = path.with_name(path.name + '.rename-tmp')
    if temporary.exists():
        raise ValueError(f'Temporary file exists: {temporary}')
    try:
        temporary.write_bytes(data)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def safe_name(value):
    value = unicodedata.normalize('NFC', value.strip())
    value = re.sub(r'[^\w.\-]+', '-', value, flags=re.UNICODE).strip(' .-')
    if not value or value in {'.', '..'}:
        raise ValueError('Original model name is empty or unsafe')
    reserved = {'con', 'prn', 'aux', 'nul', 'conin$', 'conout$'}
    reserved |= {f'{prefix}{i}' for prefix in ['com', 'lpt'] for i in range(1, 10)}
    if value.split('.')[0].casefold() in reserved:
        value = 'model-' + value
    return value[:80].rstrip(' .-')


def original_name(source_path):
    path = PurePosixPath(source_path.replace('\\', '/'))
    name = path.parent.name if path.stem.casefold() == 'model' and path.parent.name else path.stem
    if name.casefold() in {'models', 'samples', 'input'}:
        raise ValueError(f'No meaningful original model name in source_path: {source_path}')
    return safe_name(name)


def create_plan(root):
    models = root / 'assets/models'
    rows, reserved = [], set()
    builtins = root / 'assets/builtin-models.json'
    if builtins.exists():
        reserved.update(ref.removeprefix('models/').casefold() for ref in read_json(builtins)['models'])
    for directory in sorted(models.iterdir()):
        attributes = directory.lstat()
        if directory.is_symlink() or getattr(attributes, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0):
            raise ValueError(f'Model library contains a link/junction: {directory}')
        if not directory.is_dir():
            continue
        if not (directory / 'layout_manifest.json').exists():
            reserved.add(directory.name.casefold())
            continue
        manifest = read_json(directory / 'layout_manifest.json')
        source = read_json(directory / 'source.json')
        name = original_name(source['source_path'])
        rows.append({'asset_id': manifest['asset_id'], 'old_directory': directory.name,
                     'requested_name': name, 'source_path': source['source_path'],
                     'display_name': manifest.get('object_label', {}).get('display')})
    natural = {row['requested_name'].casefold() for row in rows}
    used = set(reserved)
    for row in sorted(rows, key=lambda row: (row['source_path'].casefold(), row['asset_id'])):
        name, number = row['requested_name'], 1
        while name.casefold() in used:
            number += 1
            name = f"{row['requested_name']}-{number}"
            while name.casefold() in natural or name.casefold() in used:
                number += 1
                name = f"{row['requested_name']}-{number}"
        used.add(name.casefold())
        row.update({'new_directory': name, 'old_ref': f"models/{row['old_directory']}", 'new_ref': f'models/{name}'})
    return rows


def rewrite_scene_refs(document, mapping):
    updated, count = deepcopy(document), 0
    for asset in updated['assets']:
        replacement = mapping.get(asset['ref'])
        if replacement is not None and replacement != asset['ref']:
            asset['ref'] = replacement
            count += 1
    return updated, count


def remap_inventory(before, mapping):
    result = {}
    for relative, value in before.items():
        parts = relative.split('/', 1)
        key = mapping.get(parts[0], parts[0]) + '/' + parts[1] if len(parts) == 2 else relative
        if key in result:
            raise ValueError(f'Inventory path collision: {key}')
        result[key] = value
    return result


def apply_rename(root, apply=False):
    root = root.resolve()
    models, scenes = root / 'assets/models', root / 'scenes'
    rows = create_plan(root)
    changes = [row for row in rows if row['old_directory'] != row['new_directory']]
    mapping = {row['old_ref']: row['new_ref'] for row in changes}
    directory_mapping = {row['old_directory']: row['new_directory'] for row in changes}
    documents, before_bytes, scene_count = {}, {}, 0
    for path in sorted(scenes.glob('*/scene.json')):
        before_bytes[path] = path.read_bytes()
        converted, count = rewrite_scene_refs(read_json(path), mapping)
        documents[path] = converted
        scene_count += count
    summary = {'models': len(rows), 'directories_to_rename': len(changes), 'scene_refs_to_update': scene_count,
               'scenes': len(documents), 'examples': [{k: r[k] for k in ['old_directory', 'new_directory']} for r in rows[:8]]}
    if not apply or not changes:
        print(json.dumps(summary, ensure_ascii=True, indent=2))
        print('No changes applied.' if not apply else 'Already named; no changes needed.')
        return summary

    now = datetime.now(timezone.utc)
    rename_id = now.strftime('%Y%m%dT%H%M%S%fZ')
    backup = (root / 'artifacts/model-directory-renames' / rename_id).resolve()
    if not backup.is_relative_to(root / 'artifacts') or backup.exists():
        raise ValueError('Unsafe or existing backup path')
    # Verify every resolved move endpoint before any directory move (Windows junction safe).
    for row in changes:
        if (models / row['old_directory']).resolve().parent != models.resolve() or (models / row['new_directory']).resolve().parent != models.resolve():
            raise ValueError('Rename path escapes model library')
        target = models / row['new_directory']
        if target.exists() and target.name not in directory_mapping:
            raise ValueError(f'Destination already exists: {target}')
    before_inventory = inventory(models)
    expected_inventory = remap_inventory(before_inventory, directory_mapping)
    old_catalog = read_json(root / 'assets/model-catalog.json')['models']
    missing_before = Counter(asset['ref'] for path in documents for asset in read_json(path)['assets'] if asset['ref'] not in old_catalog)
    backup.mkdir(parents=True)
    held = backup / 'held-models'
    held.mkdir()
    shutil.copytree(scenes, backup / 'scenes', copy_function=shutil.copy2)
    previous = backup / 'previous-assets'
    previous.mkdir()
    metadata_files = ['model-catalog.json', 'model-migration.json', 'model-directory-renames.json']
    for name in metadata_files:
        path = root / 'assets' / name
        if path.exists():
            shutil.copy2(path, previous / name)
    state = {'id': rename_id, 'appliedAt': now.isoformat(), 'backup': str(backup), 'status': 'prepared',
             'mapping': rows, 'before_inventory': before_inventory, 'summary': summary}
    (backup / 'rename.json').write_bytes(json_bytes(state))
    locations = {row['old_directory']: 'original' for row in changes}
    try:
        if any(path.read_bytes() != data for path, data in before_bytes.items()) or inventory(models) != before_inventory:
            raise ValueError('Inputs changed while preparing rename')
        # Two phases also handle cycles and case-only renames without overwrites.
        for row in changes:
            old = row['old_directory']
            (models / old).rename(held / old)
            locations[old] = 'held'
        for row in changes:
            old = row['old_directory']
            (held / old).rename(models / row['new_directory'])
            locations[old] = 'renamed'
        for path, document in documents.items():
            if document != read_json(backup / 'scenes' / path.parent.name / 'scene.json'):
                atomic_write(path, json_bytes(document))
        subprocess.run(['node', str(root / 'src/scripts/gen-manifest.mjs')], check=True)
        if inventory(models) != expected_inventory:
            raise ValueError('A bundle file changed during rename')
        catalog = read_json(root / 'assets/model-catalog.json')['models']
        for row in rows:
            if catalog[row['new_ref']]['id'] != row['asset_id']:
                raise ValueError('Catalog no longer preserves stable asset identity')
        for path, document in documents.items():
            if read_json(path) != document:
                raise ValueError('Scene content differs from ref-only rewrite')
        missing_after = Counter(asset['ref'] for document in documents.values() for asset in document['assets'] if asset['ref'] not in catalog)
        if missing_before != missing_after:
            raise ValueError('Renaming changed unresolved model references')
        summary.update({'bundle_files_unchanged': True, 'files_verified': len(expected_inventory),
                        'catalog_entries': len(catalog), 'preserved_missing_instances': sum(missing_after.values()),
                        'backup': str(backup)})
        record = {'id': rename_id, 'appliedAt': now.isoformat(), 'backup': str(backup),
                  'naming': 'original source model name', 'mapping': rows, 'validation': summary}
        atomic_write(root / 'assets/model-directory-renames.json', json_bytes(record))
        migration_path = root / 'assets/model-migration.json'
        if migration_path.exists():
            migration = read_json(migration_path)
            migration['directoryRename'] = {'id': rename_id, 'record': 'assets/model-directory-renames.json',
                                            'bundleContentsUnchanged': True, 'currentTreeMatchesOriginalSourcePaths': False}
            atomic_write(migration_path, json_bytes(migration))
        state.update({'status': 'applied', 'summary': summary})
        (backup / 'rename.json').write_bytes(json_bytes(state))
        print(json.dumps(summary, ensure_ascii=True, indent=2))
        return summary
    except BaseException:
        for row in changes:
            old = row['old_directory']
            if locations[old] == 'renamed':
                (models / row['new_directory']).rename(held / old)
                locations[old] = 'held'
        for row in changes:
            old = row['old_directory']
            if locations[old] == 'held':
                (held / old).rename(models / old)
        for path, data in before_bytes.items():
            atomic_write(path, data)
        shutil.copy2(backup / 'scenes/index.json', scenes / 'index.json')
        for name in metadata_files:
            source, live = previous / name, root / 'assets' / name
            if source.exists():
                shutil.copy2(source, live)
            elif live.exists():
                live.unlink()
        state['status'] = 'rolled_back'
        (backup / 'rename.json').write_bytes(json_bytes(state))
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    apply_rename(args.root, args.apply)


if __name__ == '__main__':
    main()
